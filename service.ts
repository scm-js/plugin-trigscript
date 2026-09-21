/**
 * The script service: everything the plugin does to the map, shared by the commands it
 * publishes and by the editor dialog. It reads the script's members through
 * `api.document.extras`, the map's names through `api.settings` / `api.names` /
 * `api.query`, compiles through `compile.ts`, and applies a compile with one
 * `document.update` — a settings-style transaction, outside the undo model, exactly as
 * the editor's own trigger dialogs write.
 *
 * A script has two outputs. Its `trigger()` calls are ordinary triggers: applying writes
 * them into the map's trigger list as the script's block. Its `program()`s are IR, which
 * the eudplib plugin builds into the *saved file* — never into the map the user edits —
 * so the service contributes them to the library's build (`attach`). Both happen by
 * themselves whenever the map is saved, tested or exported: the editor runs `bringUpToDate`
 * first (`buildSteps.before`), then asks the contribution.
 */
import type { PluginApi, TriggerClaimHandle } from "@scm-js/plugin-api";
import type { TriggerRecord } from "./vendor/triggers";
import { compileInBackground, type CompileInput } from "./compile";
import { ENTRY_FILE, type CompileResult, type ScriptDiagnostic, type ScriptFiles } from "./compiler/compiler";
import { generateDeclarations } from "./compiler/declarations";
import { serializeIr } from "./compiler/eud";
import { buildPlugins } from "./compiler/input";
import { TRIGSCRIPT_PY } from "./compiler/generated/trigscriptPy";
import { scriptNames, type ScriptNames } from "./compiler/names";
import { printScript, type PrintOptions } from "./compiler/print";
import { simulate, type SimulationEvent } from "./compiler/simulate";
import type { TestResult, TestRunOptions, TestWorld } from "./compiler/testing";
import { DEFAULT_DIST, DIST_STORAGE_KEY } from "./monaco";
import {
  DEFAULT_SETTINGS, buildScript, findBlock, hashFiles, hashText, isScriptMember, readManifest, readSettings, relocateManifest, scriptState, triggerAtLine, withFiles, withSettings, type ScriptSettings,
  type BuildOptions, type Extras, type ScriptBlock, type ScriptState,
} from "./script";
import { EUDPLIB_SERVICE, type EudplibBuildEvent, type EudplibInput, type EudplibService } from "./vendor/eudplib";

/**
 * A compile, with what it was compiled *for*: the map it read its names from and the
 * state those names were in. Installing checks both, so a build lands only on the map
 * and the names it was made against — another map in front by the time the worker
 * answers, or a location renamed meanwhile, is refused rather than installed.
 */
/** The start location is a unit of the file and not of the game. */
const START_LOCATION_UNIT = 214;
/** OWNR: the slots that are in a game. */
const OWNER_COMPUTER = 5;
const OWNER_HUMAN = 6;
/** "counting > deeper > the test", from a result's id. */
export const testName = (t: Pick<TestResult, "id">) => t.id.replace(/^.*?::/, "");

export interface ScriptArtifact {
  /** The files as compiled — the snapshot, not whatever the archive holds now. */
  files: ScriptFiles;
  compiled: CompileResult;
  /** `api.document.id()` when the compile started; null on a host without ids. */
  document: number | null;
  /** `MapNames.context` when the compile started. */
  context: string;
  /** `hashFiles` of the archive's files when the compile started: what the build may overwrite. */
  archived: string;
}

/** Why an artifact was not installed. */
export type BuildRefusal =
  /** The compile had errors. */
  | "errors"
  /** No map is open. */
  | "closed"
  /** Another map is in front. */
  | "switched"
  /** The map's names or reserved storage changed while the compile ran; compile again. */
  | "changed";

export interface ScriptBuildResult {
  compiled: CompileResult;
  /** Where the block landed; null when nothing was built — `refused` says why. */
  block: ScriptBlock | null;
  refused?: BuildRefusal;
  /** With `replaceStale`: what became of the edited block. */
  replaced?: { removed: number; kept: number };
}

/** Where a build failure points, when its message names a node of the IR (" at main.ts:12:5"). */
export function positionIn(message: string): { file: string; line: number; column: number } | null {
  const m = /\bat (?:([^\s:]+\.ts):)?(\d+):(\d+)\b/.exec(message);
  return m ? { file: m[1] ?? ENTRY_FILE, line: Number(m[2]), column: Number(m[3]) } : null;
}

/** A compile's first fault as one line for a notice: "main.ts:3 — no such unit (and 2 more)". */
export function firstFault(diagnostics: readonly ScriptDiagnostic[]): string {
  const d = diagnostics[0];
  if (!d) return "The script has errors.";
  return `${d.file}:${d.line} — ${d.message.split("\n")[0]}${diagnostics.length > 1 ? ` (and ${diagnostics.length - 1} more)` : ""}`;
}

/** The label the editor's notices and the library's install question name the plugin by. */
export const LABEL = "TrigScript";

export interface ScriptSimulation {
  cycles: number;
  events: SimulationEvent[];
  /** Indices of the switches that are set at the end. */
  switches: number[];
}

export interface MapNames {
  names: ScriptNames;
  /** The generated `.d.ts`. */
  decls: string;
  /** A hash over everything above: two compiles against the same context see the same map. */
  context: string;
}

/** What compiles a script: `compileInBackground`, or something synchronous in a test. */
export type Compiler = (input: CompileInput, dist: string) => Promise<CompileResult>;

/** The script's members as the map holds them, by their stored names. */
export function snapshotExtras(api: PluginApi): Map<string, Uint8Array> {
  const out = new Map<string, Uint8Array>();
  for (const name of api.document.extras.list()) {
    if (!isScriptMember(name)) continue;
    const bytes = api.document.extras.get(name);
    if (bytes) out.set(name, bytes);
  }
  return out;
}

/** Write the difference between two snapshots back to the map (marks it modified when anything changes). */
export function commitExtras(api: PluginApi, before: Extras, after: Extras): void {
  for (const name of before.keys()) if (!after.has(name)) api.document.extras.remove(name);
  for (const [name, bytes] of after) if (before.get(name) !== bytes) api.document.extras.set(name, bytes);
}

/** A command's script argument: one file's text (the entry), or the whole set of files. */
export type ScriptInput = string | ScriptFiles;

export class ScriptService {
  readonly api: PluginApi;
  readonly claim: TriggerClaimHandle;
  private readonly compiler: Compiler;
  private lastManifest: Uint8Array | null | undefined;
  /** The last compile, for a save that comes right after an apply: the same files against the same names need no second compile. */
  private lastArtifact: ScriptArtifact | null = null;

  constructor(api: PluginApi, open: (file?: string, line?: number) => void, compiler: Compiler = compileInBackground) {
    this.api = api;
    this.compiler = compiler;
    this.claim = api.triggers.claim({
      label: "the TrigScript block",
      badge: "script",
      locate: (list) => {
        const manifest = readManifest(snapshotExtras(api));
        return manifest ? findBlock(list, manifest) : null;
      },
      describe: (index, list) => {
        const at = this.sourceOf(index, list);
        return `This trigger is generated by the map's TrigScript${at ? ` (${at.file}, line ${at.line})` : ""}. Edit the source instead; applying the script (saving the map does it) replaces the whole block.`;
      },
      open: (index, list) => { const at = this.sourceOf(index, list); open(at?.file, at?.line); },
      openLabel: "Open TrigScript",
    });
  }

  private sourceOf(index: number, list: TriggerRecord[]): { file: string; line: number } | null {
    const manifest = readManifest(snapshotExtras(this.api));
    const block = manifest ? findBlock(list, manifest) : null;
    return block ? block.sources[index - block.start] ?? null : null;
  }

  /** The Monaco build's base URL — the standard library is fetched from there too. */
  dist(): string {
    return this.api.storage.get(DIST_STORAGE_KEY, DEFAULT_DIST);
  }

  /** The map's script files, its manifest, and whether the built block is still intact. Null with no map. */
  state(): ScriptState | null {
    if (!this.api.document.isOpen()) return null;
    return scriptState(this.api.triggers.list(), snapshotExtras(this.api));
  }

  /** The eudplib plugin's service, or null when it is not installed or is off. */
  library(): EudplibService | null {
    return this.api.services.get<EudplibService>(EUDPLIB_SERVICE);
  }

  /** Called at once and whenever the eudplib plugin arrives or goes. */
  watchLibrary(listener: (service: EudplibService | null) => void): { dispose(): void } {
    return this.api.services.watch<EudplibService>(EUDPLIB_SERVICE, (s) => listener(s));
  }

  /**
   * Take part in saving: bring the map's block up to date before its bytes are produced,
   * and hand the programs to the eudplib plugin's build. Dispose when the plugin goes.
   */
  attach(): { dispose(): void } {
    const before = this.api.document.buildSteps?.before({
      id: "apply", label: LABEL,
      applies: () => this.api.document.isOpen() && snapshotExtras(this.api).size > 0,
      run: () => this.bringUpToDate(),
    });
    let mine: { dispose(): void } | null = null;
    const watch = this.watchLibrary((library) => {
      mine?.dispose();
      mine = library?.contribute?.({ id: "trigscript", label: LABEL, applies: () => this.hasPrograms(), collect: () => this.collect() }) ?? null;
    });
    return { dispose: () => { before?.dispose(); mine?.dispose(); watch.dispose(); } };
  }

  /** Whether the map's script, as last applied, has programs — read off the manifest, so it costs a save nothing. */
  hasPrograms(): boolean {
    if (!this.api.document.isOpen()) return false;
    return (readManifest(snapshotExtras(this.api))?.programs ?? 0) > 0;
  }

  /**
   * Apply the script when its files are newer than the block: what Save, Test Map and an
   * export do first. Throws, worded for the editor's notice, when the script does not
   * compile or its block was edited by hand — the map is then saved as it stands.
   */
  async bringUpToDate(): Promise<void> {
    const state = this.state();
    if (!state?.files || !state.unbuilt) return;
    if (state.stale) throw new Error("The script's triggers were edited or removed outside the script, so it was not applied. Open Triggers ▸ TrigScript… and press Apply to choose what becomes of them.");
    const guard = this.settings().testsGuardBuild;
    if (guard) this.guardTests((await this.prepare(state.files, this.names(), { world: this.world() })).compiled);
    const out = await this.build(state.files);
    if (out.refused === "errors") throw new Error(firstFault(out.compiled.diagnostics));
    if (out.refused) throw new Error("The map changed while the script was compiling; save again.");
  }

  /**
   * The world a simulation and every test start from, as plain data: the map's placed units (start locations apart) with
   * the hit points their type and their own percentage give, its locations as boxes, the human and computer players in
   * their forces, what each unit type is made with, the Create Unit with Properties slots, and the script's settings.
   */
  world(): TestWorld {
    const scn = this.api.document.scenario();
    if (!scn) return {};
    const unitStats: NonNullable<TestWorld["unitStats"]> = {};
    for (const view of this.api.settings.unitTypes()) unitStats[view.id] = { hp: view.hitPoints, shields: view.shields };
    const part = (max: number, percent: number, valid: boolean) => (valid ? Math.max(1, Math.ceil((max * Math.min(100, percent)) / 100)) : max);
    const units = scn.units.filter((u) => u.unitId !== START_LOCATION_UNIT).map((u) => {
      const t = unitStats[u.unitId] ?? {};
      const hp = t.hp ?? 1, shields = t.shields ?? 0;
      return {
        type: u.unitId, owner: u.owner, x: u.x, y: u.y,
        // validStates says which of a placed unit's own figures are set: 2 hit points, 4 shields, 64 the state flags.
        maxHp: hp, hp: part(hp, u.hitPointsPercent, (u.validStates & 2) !== 0),
        maxShields: shields, shields: shields ? part(shields, u.shieldPercent, (u.validStates & 4) !== 0) : 0,
        resources: u.resourceAmount,
        ...((u.validStates & 64) !== 0 ? { cloaked: (u.stateFlags & 1) !== 0, burrowed: (u.stateFlags & 2) !== 0, hallucinated: (u.stateFlags & 8) !== 0, invincible: (u.stateFlags & 16) !== 0 } : {}),
      };
    });
    const locations: NonNullable<TestWorld["locations"]> = {};
    scn.locations.forEach((l, i) => { if (l.right > l.left || l.bottom > l.top) locations[i + 1] = { left: l.left, top: l.top, right: l.right, bottom: l.bottom }; });
    // Who is in the game: the map's human and computer players, each in the force the map puts them in.
    const players = scn.playerTypes.slice(0, 8).flatMap((type, slot) => (type === OWNER_HUMAN || type === OWNER_COMPUTER ? [slot] : []));
    const forces = Object.fromEntries(scn.forces.playerForce.slice(0, 8).map((force, slot) => [slot, force]));
    const properties = (scn.cuwp ?? []).map((c) => {
      const state = (bit: number) => ((c.validProperties & bit) !== 0 ? (c.stateFlags & bit) !== 0 : undefined);
      return {
        hpPercent: c.validFields & 2 ? c.hitPointsPercent : undefined, shieldPercent: c.validFields & 4 ? c.shieldsPercent : undefined,
        energyPercent: c.validFields & 8 ? c.energyPercent : undefined, resources: c.validFields & 16 ? c.resources : undefined,
        cloaked: state(1), burrowed: state(2), hallucinated: state(8), invincible: state(16),
      };
    });
    const settings = this.settings();
    return { units, locations, ...(players.length ? { players, forces } : {}), unitStats, properties, heapCells: settings.heapCells, stackDepth: settings.stackDepth };
  }

  /** With the map's setting on, a failing test refuses the build: said as the first of them, and how many. */
  private guardTests(compiled: CompileResult): void {
    const failed = (compiled.tests?.results ?? []).filter((t) => t.status === "failed");
    if (failed.length === 0) return;
    const first = failed[0];
    throw new Error(`Not built: ${failed.length === 1 ? "a test fails" : `${failed.length} tests fail`} — ${testName(first)}: ${first.message ?? "failed"}. (The script's settings make a failing test refuse the build.)`);
  }

  /** The programs for the library's build: the IR as a data file, the lowering as a source, eudTurbo so the game runs them every frame. */
  async collect(): Promise<EudplibInput> {
    const state = this.state();
    if (!state?.files) throw new Error("The map has no script.");
    const map = this.names();
    const cached = this.lastArtifact;
    const guard = this.settings().testsGuardBuild;
    const fresh = cached && map && cached.context === map.context && cached.document === this.documentId() && hashFiles(cached.files) === hashFiles(state.files) && (!guard || !cached.compiled.tests || cached.compiled.tests.results.length > 0);
    const artifact = fresh ? cached : await this.prepare(state.files, map, guard ? { world: this.world() } : undefined);
    if (!artifact.compiled.ok) throw new Error(firstFault(artifact.compiled.diagnostics));
    if (guard) this.guardTests(artifact.compiled);
    return {
      // chatEvent and MSQC join in, around the lowering, when a program reads what the players do.
      plugins: buildPlugins(artifact.compiled.input, "/work/files/trigscript.json"),
      sources: { trigscript: TRIGSCRIPT_PY },
      files: { "trigscript.json": serializeIr(artifact.compiled.ir, artifact.compiled.strings, artifact.compiled.input, this.settings()) },
    };
  }

  /** Hear about the library's builds (it runs them on Save, Test Map and export): the log, and where a failure points. */
  onBuild(listener: (event: EudplibBuildEvent) => void): { dispose(): void } {
    let mine: { dispose(): void } | null = null;
    const watch = this.watchLibrary((library) => { mine?.dispose(); mine = library?.onBuild?.(listener) ?? null; });
    return { dispose: () => { mine?.dispose(); watch.dispose(); } };
  }

  /** The tables and the `.d.ts` for the open map — its forces, used locations, switch names and custom unit names. Null with no map. */
  names(): MapNames | null {
    const api = this.api;
    const info = api.document.info();
    if (!info) return null;
    const custom = new Map(api.settings.unitTypes().map((u) => [u.id, u.customName]));
    // Used locations: every slot with a box on the map (Anywhere is added by the tables when it is not listed).
    const used = [...new Set(api.query.locationsIn({ x0: 0, y0: 0, x1: info.width, y1: info.height }))].sort((a, b) => a - b);
    const switchNames = api.triggers.switchNames();
    const names = scriptNames({
      forceNames: api.settings.forces().map((f) => f.name || null),
      locations: used.map((index) => ({ index, name: api.names.location(index) })),
      switchNames,
      unitCustomName: (id) => custom.get(id) || null,
    });
    const decls = generateDeclarations(names);
    return { names, decls, context: hashText(decls) };
  }

  /** The id of the map in front, or null on a host without ids (every map then compares equal). */
  documentId(): number | null {
    const doc = this.api.document as { id?: () => number | null };
    return typeof doc.id === "function" ? doc.id() : null;
  }

  /** The declarations for the open map; `compact` is the shorter variant for a language model. */
  declarations(options: { compact?: boolean } = {}): string {
    const map = this.names();
    if (!map) return "";
    return options.compact ? generateDeclarations(map.names, { compact: true }) : map.decls;
  }

  /** A command's input as files: a string is the entry file, over the map's other files. */
  filesOf(input: ScriptInput): ScriptFiles {
    if (typeof input !== "string") return { ...input };
    return { ...(this.state()?.files ?? {}), [ENTRY_FILE]: input };
  }

  /** Compile against the open map's names; rejects with `CompileSuperseded` when a newer compile started first. */
  async compile(input: ScriptInput): Promise<CompileResult> {
    return (await this.prepare(input)).compiled;
  }

  /**
   * Compile into an artifact `install` can check: the files as they are now, against the
   * map in front and its names as they are now (`map`, when the caller already has them —
   * the editor keeps a copy that follows the map's events).
   */
  async prepare(input: ScriptInput, map: MapNames | null = this.names(), tests?: TestRunOptions): Promise<ScriptArtifact> {
    if (!map) throw new Error("No map is open.");
    const files = this.filesOf(input);
    const document = this.documentId();
    const archived = hashFiles(this.state()?.files ?? {});
    const compiled = await this.compiler({ files, names: map.names, ...(tests ? { tests } : {}) }, this.dist());
    const artifact = { files, compiled, document, context: map.context, archived };
    this.lastArtifact = artifact;
    return artifact;
  }

  /**
   * Install an artifact as the block — replacing the previous one, or appending when the
   * previous was edited by hand — and store its files with the map, in one
   * `document.update`. Refused, with the reason, when it has errors or the map it was
   * compiled for is not the one in front any more (closed, switched, or changed under
   * it). Files edited in the archive since the compile started are left as they are.
   * `takeOver` replaces the whole trigger list with the script's.
   */
  install(artifact: ScriptArtifact, options: BuildOptions = {}): ScriptBuildResult {
    const { compiled, files } = artifact;
    const refuse = (refused: BuildRefusal): ScriptBuildResult => ({ compiled, block: null, refused });
    if (!this.api.document.isOpen()) return refuse("closed");
    if (this.documentId() !== artifact.document) return refuse("switched");
    const map = this.names();
    // Before the errors: a compile against names that changed under it may have failed *because* they did.
    if (!map || map.context !== artifact.context) return refuse("changed");
    if (!compiled.ok) return refuse("errors");
    const keepFiles = hashFiles(this.state()?.files ?? {}) !== artifact.archived;
    let block: ScriptBlock | null = null;
    let replaced: ScriptBuildResult["replaced"];
    this.api.document.update("Apply TrigScript", (tx) => {
      const before = snapshotExtras(this.api);
      const intern = (text: string) => tx.strings.intern(text);
      const plan = buildScript(tx.triggers.list(), before, files, compiled, intern, { ...options, keepFiles });
      tx.triggers.set(plan.list);
      commitExtras(this.api, before, plan.extras);
      block = plan.block;
      replaced = plan.replaced;
    });
    this.claim.refresh();
    if (block) {
      const b: ScriptBlock = block;
      const n = compiled.ir.length;
      const programs = n ? ` ${n} program${n === 1 ? "" : "s"} will be built into the saved map (StarCraft: Remastered).` : "";
      this.api.ui.status((b.count === 0 ? "Applied: the script defines no triggers." : `Applied ${b.count} trigger${b.count === 1 ? "" : "s"} → #${b.start + 1}–#${b.start + b.count}.`) + programs);
    }
    return { compiled, block, ...(replaced ? { replaced } : {}) };
  }

  /**
   * `prepare` then `install`. When the map changed under the compile, it is compiled
   * again against the new names, twice at most, before the refusal is reported.
   */
  async build(input: ScriptInput, options: BuildOptions = {}): Promise<ScriptBuildResult> {
    for (let attempt = 0; ; attempt++) {
      const out = this.install(await this.prepare(input), options);
      if (out.refused !== "changed" || attempt >= 2) return out;
    }
  }

  /** Records as raw `trigger()` calls in the script language — what Import map triggers writes. */
  print(triggers: TriggerRecord[], options?: PrintOptions): string {
    const names = this.names()?.names ?? scriptNames();
    return printScript(triggers, { names, string: (i) => this.api.names.string(i) }, options);
  }

  /** The trigger-cycle interpreter over records: Deaths, Switch, Always and Never modelled, other conditions false, other actions logged. */
  simulate(triggers: TriggerRecord[], cycles: number, options: { player?: number } = {}): ScriptSimulation {
    const sim = simulate(triggers, cycles, { player: options.player, strings: (i) => this.api.names.string(i) });
    const switches: number[] = [];
    sim.switches.forEach((v, i) => { if (v) switches.push(i); });
    return { cycles: sim.cycle, events: sim.events, switches };
  }

  /** The index of the trigger a 1-based line of a file generated, per the build manifest; null when none did or the block is stale. */
  triggerAt(file: string, line: number): number | null {
    const state = this.state();
    return state?.block && !state.stale ? triggerAtLine(state.block, file, line) : null;
  }

  /** What the map's author chose about the build (`script.ts#ScriptSettings`); the defaults when no map is open. */
  settings(): ScriptSettings {
    return this.api.document.isOpen() ? readSettings(snapshotExtras(this.api)) : { ...DEFAULT_SETTINGS };
  }

  /** The settings into the archive (the map is modified); the next save builds with them. */
  writeSettings(settings: ScriptSettings): void {
    if (!this.api.document.isOpen()) return;
    const before = snapshotExtras(this.api);
    commitExtras(this.api, before, withSettings(before, settings));
  }

  /** The files as typed, straight into the archive (the map is modified; only applying changes triggers). */
  writeFiles(files: ScriptFiles): void {
    if (!this.api.document.isOpen()) return;
    const before = snapshotExtras(this.api);
    commitExtras(this.api, before, withFiles(before, files));
  }

  /** The hand-made triggers around the block, in list order: what Import map triggers rewrites as script. */
  handTriggers(): { before: TriggerRecord[]; after: TriggerRecord[] } {
    const list = this.api.triggers.list();
    const block = this.state()?.block ?? null;
    return block ? { before: list.slice(0, block.start), after: list.slice(block.start + block.count) } : { before: list, after: [] };
  }

  /** After the trigger list changed under the block: point the manifest at where it went. */
  relocate(): void {
    if (!this.api.document.isOpen()) return;
    const before = snapshotExtras(this.api);
    const moved = relocateManifest(this.api.triggers.list(), before);
    if (moved) commitExtras(this.api, before, moved);
  }

  /** The manifest member changed (a build, a relocation, another map): the editors should ask `locate` again. */
  manifestChanged(): boolean {
    const now = readManifestBytes(this.api);
    const changed = now !== this.lastManifest;
    this.lastManifest = now;
    return changed;
  }
}

function readManifestBytes(api: PluginApi): Uint8Array | null {
  for (const [name, bytes] of snapshotExtras(api)) if (name.toLowerCase().endsWith("build.json")) return bytes;
  return null;
}
