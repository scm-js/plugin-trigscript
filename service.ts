/**
 * The script service: everything the plugin does to the map, shared by the commands it
 * publishes and by the editor dialog. It reads the script's members through
 * `api.document.extras`, the map's names through `api.settings` / `api.names` /
 * `api.query`, compiles through `compile.ts`, and applies a compile with one
 * `document.update` — a settings-style transaction, outside the undo model, exactly as
 * the editor's own trigger dialogs write.
 *
 * A script has two outputs. Its `trigger()` calls are ordinary triggers: applying writes
 * them into the map's trigger list as the script's block. Its `program()`s are IR, built
 * into the *saved file* — never into the map the user edits — by TrigScript's own build
 * step (`buildOwn`, `compiler/backend/build.ts`). That happens by itself whenever the map
 * is saved, tested or exported: the editor runs `bringUpToDate` first (`buildSteps.before`),
 * then the build step (`attach`). (Until TrigScript 4's step 17 a program the build did not
 * take went through the eudplib plugin instead; now it is a failure the notice says.)
 */
import type { PluginApi, TriggerClaimHandle } from "@scm-js/plugin-api";
import type { TriggerRecord } from "./vendor/triggers";
import { buildInBackground, compileInBackground, type CompileInput } from "./compile";
import { isRefused, type OwnBuildInput, type OwnBuildOutcome } from "./compiler/backend/build";
import { ENTRY_FILE, type CompileResult, type OwnCheck, type ScriptDiagnostic, type ScriptFiles } from "./compiler/compiler";
import { generateDeclarations } from "./compiler/declarations";
import { scriptNames, type ScriptNames } from "./compiler/names";
import { printScript, type PrintOptions } from "./compiler/print";
import { simulate, type SimulationEvent } from "./compiler/simulate";
import type { TestResult, TestRunOptions, TestWorld } from "./compiler/testing";
import { DEFAULT_DIST, DIST_STORAGE_KEY } from "./monaco";
import {
  DEFAULT_SETTINGS, buildScript, findBlock, hashFiles, hashText, isBuiltSound, isScriptMember, readManifest, readSettings, relocateManifest, scriptState, triggerAtLine, withFiles, withSettings, type ScriptSettings,
  type BuildOptions, type Extras, type ScriptBlock, type ScriptState,
} from "./script";
import { english, msg, type Translate } from "./i18n";
import { SCM_SIM_SERVICE, type ScmSimEngine } from "./vendor/scmSim";

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

/** A contribution's `collect` threw, or brought what it may not: the error carries whose it was. */
class ContributionError extends Error {
  readonly contribution: BuildContribution;
  constructor(contribution: BuildContribution, message: string) {
    super(`${contribution.label}: ${message}`);
    this.contribution = contribution;
  }
}

/** Where a refusal of the own build points: ", line N" and ", line N of <file>" at its end (`refusedAt` in the emitter). */
export function refusalAt(refusal: string): { reason: string; line: number | null; file: string | null } {
  const m = /, line (\d+)(?: of (\S+))?$/.exec(refusal);
  return m ? { reason: refusal.slice(0, m.index), line: Number(m[1]), file: m[2] ?? null } : { reason: refusal, line: null, file: null };
}

/** The label the editor's notices name the plugin by. */
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
/** What builds a map of our own: `buildInBackground`, or `buildOwnMap` itself in a test. */
export type OwnBuilder = (input: OwnBuildInput, dist: string) => Promise<OwnBuildOutcome>;

/**
 * The member the Magenta plugin keeps its triggers in. A Magenta that builds through the eudplib plugin rewrites the
 * strings section TrigScript's payload sits behind, so the two cannot share a map: while such a Magenta is the one
 * running (none has contributed to this build, `contribute`), a map with this member in it is not built (`buildOwn`
 * says so) and Magenta's build runs alone. A Magenta that builds with TrigScript contributes as "magenta".
 */
export const MAGENTA_MEMBER = "magenta\\magenta.json";
const MAGENTA = "magenta";

/**
 * What another plugin brings to the build (TrigScript as the library, 2026-10-25): TrigScript source of its own,
 * compiled with the map's script and laid out into the map by the same build — Magenta's rows, say. The copy other
 * plugins import is `contract.d.ts`.
 */
export interface BuildContribution {
  /** The plugin's id ("magenta"): what the build's events name it by. */
  id: string;
  /** What the notice calls it. */
  label: string;
  /** Asked on every save: cheap, synchronous, no side effects. */
  applies(): boolean;
  /** Its part of the build for the open map as it is now. Throw an `Error` worded for the user. */
  collect(ctx: { purpose: "save" | "test" | "export"; signal: AbortSignal }): Promise<ContributedScript>;
}

/**
 * The files a contribution brings — TrigScript source by path, under a folder of its own (`magenta/…`) so that they
 * cannot shadow the map's — and which of them run as entries, in order. Their `program()`s are built into the map
 * after the script's; a `trigger()` in them is a problem (`check`), since nothing writes it into the trigger list.
 */
export interface ContributedScript { files: ScriptFiles; entries: string[] }

/** What `check` says of a contribution's source, as a build would compile it: each problem at its file and line. */
export interface ContributionCheck { problems: { file: string; line: number; column: number; message: string }[]; programs: number }

/** The service other plugins reach as `trigscript.build` (`contract.d.ts` is its published shape). */
export interface BuildService {
  versions: { plugin: string };
  contribute(contribution: BuildContribution): { dispose(): void };
  onBuild(listener: (event: OwnBuildEvent) => void): { dispose(): void };
  check(files: ScriptFiles, entries: string[]): Promise<ContributionCheck>;
}

/**
 * What a build of the programs says as it goes (`onBuild`): its start, each line of its log, its end or its failure —
 * and a warning: a trigger of the map's own left out or never run (`OwnBuild.warnings`). (The shape is the eudplib
 * library's build events, which the editor heard beside these until step 17.)
 */
export type OwnBuildEvent =
  | { kind: "start"; purpose: "save" | "test" | "export"; contributors: string[] }
  | { kind: "log"; line: string }
  | { kind: "done"; purpose: "save" | "test" | "export"; contributors: string[]; log: string; chkBytes: number; ms: number }
  | { kind: "failed"; purpose: "save" | "test" | "export"; contributors: string[]; from: string | null; message: string; log: string }
  | { kind: "warning"; message: string };

/** The script's members as the map holds them, by their stored names, and the WAVs its last build wrote for its clips. */
export function snapshotExtras(api: PluginApi): Map<string, Uint8Array> {
  const out = new Map<string, Uint8Array>();
  for (const name of api.document.extras.list()) {
    if (!isScriptMember(name) && !isBuiltSound(name)) continue;
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
  private readonly builder: OwnBuilder;
  /** Who hears about the builds TrigScript does itself (`onBuild`). */
  private readonly ownListeners = new Set<(event: OwnBuildEvent) => void>();
  /** The other plugins' parts of the build (`contribute`), by id. */
  private readonly contributions = new Map<string, BuildContribution>();
  private lastManifest: Uint8Array | null | undefined;
  /** The last compile, for a save that comes right after an apply: the same files against the same names need no second compile. */
  private lastArtifact: ScriptArtifact | null = null;
  /** Builds under way that want the lowering to say where the programs' variables are (`withVariableMap`). */
  private variableMaps = 0;
  /** The editor's language, for what a person reads in the editor's own trigger editors and notices; what the commands return stays English. */
  private readonly t: Translate;

  constructor(api: PluginApi, open: (file?: string, line?: number) => void, compiler: Compiler = compileInBackground, builder: OwnBuilder = buildInBackground) {
    this.api = api;
    this.compiler = compiler;
    this.builder = builder;
    const t: Translate = api.i18n ? (text, params) => api.i18n.t(text, params) : english;
    this.t = t;
    this.claim = api.triggers.claim({
      label: msg("the TrigScript block"),
      badge: msg("script"),
      locate: (list: TriggerRecord[]) => {
        const manifest = readManifest(snapshotExtras(api));
        return manifest ? findBlock(list, manifest) : null;
      },
      describe: (index, list: TriggerRecord[]) => {
        const at = this.sourceOf(index, list);
        return at
          ? t("This trigger is generated by the map's TrigScript ({file}, line {line}). Edit the source instead; applying the script (saving the map does it) replaces the whole block.", { file: at.file, line: at.line })
          : t("This trigger is generated by the map's TrigScript. Edit the source instead; applying the script (saving the map does it) replaces the whole block.");
      },
      open: (index, list: TriggerRecord[]) => { const at = this.sourceOf(index, list); open(at?.file, at?.line); },
      openLabel: msg("Open TrigScript"),
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

  /** The scm-sim plugin's engine, or null when it is not installed or is off: where a script's tests run in the game. */
  engine(): ScmSimEngine | null {
    return this.api.services.get<ScmSimEngine>(SCM_SIM_SERVICE);
  }

  /** Called at once and whenever the scm-sim plugin arrives or goes. */
  watchEngine(listener: (service: ScmSimEngine | null) => void): { dispose(): void } {
    return this.api.services.watch<ScmSimEngine>(SCM_SIM_SERVICE, (s) => listener(s));
  }

  /**
   * Take part in saving: bring the map's block up to date before its bytes are produced, then build the programs
   * into the map (TrigScript 4, step 14). Dispose when the plugin goes.
   */
  attach(): { dispose(): void } {
    const before = this.api.document.buildSteps?.before({
      id: "apply", label: LABEL,
      applies: () => this.api.document.isOpen() && snapshotExtras(this.api).size > 0,
      run: () => this.bringUpToDate(),
    });
    const step = this.api.document.buildSteps?.add({
      id: "build", label: LABEL,
      applies: () => this.hasPrograms() || this.contributionsApply(),
      run: (input) => this.buildOwn(input),
    });
    return { dispose: () => { before?.dispose(); step?.dispose(); } };
  }

  /** Another plugin's standing offer to take part in the build (`BuildContribution`); the second of one id replaces the first. */
  contribute(contribution: BuildContribution): { dispose(): void } {
    this.contributions.set(contribution.id, contribution);
    return { dispose: () => { if (this.contributions.get(contribution.id) === contribution) this.contributions.delete(contribution.id); } };
  }

  /** Whether any contribution has something for the open map. */
  contributionsApply(): boolean {
    if (!this.api.document.isOpen()) return false;
    for (const c of this.contributions.values()) if (c.applies()) return true;
    return false;
  }

  /** The service held out to other plugins as `trigscript.build`. */
  buildService(version: string): BuildService {
    return {
      versions: { plugin: version },
      contribute: (c) => this.contribute(c),
      onBuild: (l) => this.onBuild(l),
      check: (files, entries) => this.check(files, entries),
    };
  }

  /**
   * A contribution's source as a build would compile it, without building: the problems (TypeScript's, the compiler's,
   * a `trigger()` where only programs go, what the own build does not take), for the contributor's own preflight.
   */
  async check(files: ScriptFiles, entries: string[]): Promise<ContributionCheck> {
    const map = this.names();
    const at = entries[0] ?? Object.keys(files)[0] ?? ENTRY_FILE;
    if (!map) return { problems: [{ file: at, line: 1, column: 1, message: this.t("No map is open.") }], programs: 0 };
    const own = this.ownCheck();
    const r = await this.compiler({ files: { [ENTRY_FILE]: "", ...files }, names: map.names, entries, ...(own ? { own } : {}) }, this.dist());
    const problems: ContributionCheck["problems"] = r.diagnostics.map((d) => ({ file: d.file, line: d.line, column: d.column, message: d.message }));
    if (r.ok && r.triggers.length) problems.push({ file: at, line: 1, column: 1, message: this.t("A contribution holds programs only: its trigger() calls are not written into the map.") });
    if (r.ok && r.ownRefusal) {
      const where = refusalAt(r.ownRefusal);
      problems.push({ file: where.file ?? at, line: where.line ?? 1, column: 1, message: this.t("TrigScript does not take this yet ({reason}).", { reason: where.reason }) });
    }
    return { problems, programs: r.ir.length };
  }

  /** The contributions that apply, collected: their files and entries together, and which contribution each file is. */
  private async collectContributions(ctx: { purpose: "save" | "test" | "export"; signal: AbortSignal }): Promise<{ files: ScriptFiles; entries: string[]; of: Map<string, BuildContribution> }> {
    const files: ScriptFiles = {}, entries: string[] = [], of = new Map<string, BuildContribution>();
    for (const c of this.contributions.values()) {
      if (!c.applies()) continue;
      let brought: ContributedScript;
      try { brought = await c.collect(ctx); } catch (err) { throw new ContributionError(c, err instanceof Error ? err.message : String(err)); }
      for (const [path, text] of Object.entries(brought.files)) {
        if (!path.startsWith(`${c.id}/`)) throw new ContributionError(c, this.t("{label} brought the file {file}, which is not under its own folder ({folder}/).", { label: c.label, file: path, folder: c.id }));
        files[path] = text;
        of.set(path, c);
      }
      entries.push(...brought.entries);
    }
    return { files, entries, of };
  }

  /** Whether the map's script, as last applied, has programs — read off the manifest, so it costs a save nothing. */
  hasPrograms(): boolean {
    if (!this.api.document.isOpen()) return false;
    return (readManifest(snapshotExtras(this.api))?.programs ?? 0) > 0;
  }

  /** Why the programs cannot be built into this map, in the user's words — a Magenta that builds through eudplib has triggers in it — or null. */
  whyNotBuilt(): string | null {
    if (!this.api.document.isOpen()) return null;
    if (this.api.document.extras.get(MAGENTA_MEMBER) !== null && !this.contributions.has(MAGENTA)) return this.t("Magenta's triggers are in this map, and this Magenta builds them through eudplib, which rewrites the part of the map TrigScript's programs go into. Update Magenta to the version that builds with TrigScript, or keep the two in different maps.");
    return null;
  }

  /** The open map as a map of our own is checked against while the script is typed: who plays, and its size in pixels. */
  ownCheck(): OwnCheck | null {
    const scn = this.api.document.scenario();
    if (!scn) return null;
    const types = scn.playerTypes.slice(0, 8);
    return {
      players: { slots: types.flatMap((type, slot) => (type === OWNER_HUMAN || type === OWNER_COMPUTER ? [slot] : [])), forces: scn.forces.playerForce.slice(0, 8) },
      humans: types.flatMap((type, slot) => (type === OWNER_HUMAN ? [slot] : [])),
      width: scn.width * 32,
      height: scn.height * 32,
    };
  }

  /**
   * The build step: the scenario out of the map Save made (the script applied), the programs laid out into it by
   * TrigScript itself (`compiler/backend/build.ts`, in the compile worker), the scenario back — the editor lays the
   * file out with the user's save options and the map's members as they are. What the other plugins contribute
   * (`contribute`) is compiled with the script and built with it, their programs after the script's. Throws, worded
   * for the editor's notice, when the script or a contribution does not compile, the build does not take it, or a
   * Magenta that builds through eudplib has triggers in the map; the map is then saved without its programs.
   */
  async buildOwn(input: { map: Uint8Array; purpose: "save" | "test" | "export"; signal: AbortSignal }): Promise<Uint8Array> {
    const started = Date.now();
    const contributors = ["trigscript"];
    const lines: string[] = [];
    const say = (event: OwnBuildEvent) => { for (const l of this.ownListeners) l(event); };
    const log = (line: string) => { lines.push(line); say({ kind: "log", line }); };
    say({ kind: "start", purpose: input.purpose, contributors });
    let from = "trigscript";
    try {
      const state = this.state();
      const why = this.whyNotBuilt();
      if (why) throw new Error(why);
      const brought = await this.collectContributions(input);
      for (const c of new Set(brought.of.values())) contributors.push(c.id);
      if (!state?.files && !brought.entries.length) throw new Error(this.t("The map has no script."));
      const map = this.names();
      if (!map) throw new Error(this.t("No map is open."));
      const guard = this.settings().testsGuardBuild;
      // The map's own script, as the apply compiled it (its tests guard the build when the settings say so).
      let compiled: CompileResult | null = null;
      if (state?.files) {
        const cached = this.lastArtifact;
        const fresh = cached && cached.context === map.context && cached.document === this.documentId() && hashFiles(cached.files) === hashFiles(state.files) && (!guard || !cached.compiled.tests || cached.compiled.tests.results.length > 0);
        const artifact = fresh ? cached : await this.prepare(state.files, map, guard ? { world: this.world() } : undefined);
        if (!artifact.compiled.ok) throw new Error(firstFault(artifact.compiled.diagnostics));
        if (guard) this.guardTests(artifact.compiled);
        compiled = artifact.compiled;
      }
      // With contributions: the script and what they bring, compiled together, their entries after the script's.
      if (brought.entries.length) {
        const files = { ...(state?.files ?? { [ENTRY_FILE]: "" }), ...brought.files };
        compiled = await this.compiler({ files, names: map.names, entries: brought.entries }, this.dist());
        if (!compiled.ok) {
          const fault = compiled.diagnostics[0];
          const c = fault && brought.of.get(fault.file);
          if (c) { from = c.id; throw new Error(`${c.label}: ${firstFault(compiled.diagnostics)}`); }
          throw new Error(firstFault(compiled.diagnostics));
        }
        const contributedTriggers = compiled.sources.filter((s) => s && brought.of.has(s.file)).length;
        if (contributedTriggers) {
          const c = brought.of.get(compiled.sources.find((s) => s && brought.of.has(s.file))!.file)!;
          from = c.id;
          throw new Error(this.t("{label} brought trigger() calls, and a contribution holds programs only.", { label: c.label }));
        }
      }
      const chk = await this.api.document.sections.chkOf(input.map);
      const { heapCells, stackDepth } = this.settings();
      log(brought.entries.length
        ? this.t("Built by TrigScript: {n, plural, one {# program} other {# programs}} laid out into the map, {contributors} among them", { n: compiled!.ir.length, contributors: [...new Set(brought.of.values())].map((c) => c.label).join(", ") })
        : this.t("Built by TrigScript: {n, plural, one {# program} other {# programs}} laid out into the map", { n: compiled!.ir.length }));
      // (With the maps of where the triggers and the variables are, for a test run in the lifted game: `withVariableMap`.)
      const out = await this.builder({ chk, compiled: { ir: compiled!.ir, strings: compiled!.strings, input: compiled!.input, triggers: [] }, settings: { heapCells, stackDepth }, ...(this.variableMaps ? { maps: true } : {}) }, this.dist());
      if (isRefused(out)) {
        const where = refusalAt(out.refused);
        const c = where.file ? brought.of.get(where.file) : undefined;
        if (c) { from = c.id; throw new Error(this.t("{label}: TrigScript does not take this yet ({reason}).", { label: c.label, reason: out.refused })); }
        throw new Error(this.t("The programs were not built: TrigScript does not take this yet ({reason}).", { reason: out.refused }));
      }
      for (const line of out.lines) log(line);
      for (const line of out.maps?.lines ?? []) log(line);
      for (const message of out.warnings) say({ kind: "warning", message });
      say({ kind: "done", purpose: input.purpose, contributors, log: lines.join("\n"), chkBytes: out.chk.length, ms: Date.now() - started });
      return out.chk;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (err instanceof ContributionError) from = err.contribution.id;
      say({ kind: "failed", purpose: input.purpose, contributors, from, message, log: lines.join("\n") });
      throw err;
    }
  }

  /**
   * Apply the script when its files are newer than the block: what Save, Test Map and an
   * export do first. Throws, worded for the editor's notice, when the script does not
   * compile or its block was edited by hand — the map is then saved as it stands.
   */
  async bringUpToDate(): Promise<void> {
    const state = this.state();
    if (!state?.files || !state.unbuilt) return;
    if (state.stale) throw new Error(this.t("The script's triggers were edited or removed outside the script, so it was not applied. Open Triggers ▸ TrigScript… and press Apply to choose what becomes of them."));
    const guard = this.settings().testsGuardBuild;
    if (guard) this.guardTests((await this.prepare(state.files, this.names(), { world: this.world() })).compiled);
    const out = await this.build(state.files);
    if (out.refused === "errors") throw new Error(firstFault(out.compiled.diagnostics));
    if (out.refused) throw new Error(this.t("The map changed while the script was compiling; save again."));
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
    const computers = scn.playerTypes.slice(0, 8).flatMap((type, slot) => (type === OWNER_COMPUTER ? [slot] : []));
    const settings = this.settings();
    return { units, locations, ...(players.length ? { players, forces, computers } : {}), unitStats, properties, heapCells: settings.heapCells, stackDepth: settings.stackDepth };
  }

  /** With the map's setting on, a failing test refuses the build: said as the first of them, and how many. */
  private guardTests(compiled: CompileResult): void {
    const failed = (compiled.tests?.results ?? []).filter((t) => t.status === "failed");
    if (failed.length === 0) return;
    const first = failed[0];
    throw new Error(`Not built: ${failed.length === 1 ? "a test fails" : `${failed.length} tests fail`} — ${testName(first)}: ${first.message ?? "failed"}. (The script's settings make a failing test refuse the build.)`);
  }

  /**
   * `run` with every build it starts asked to say where the programs' variables and its triggers are — lines of the
   * build's log (`compiler/gameVariables.ts`) — for tests in the lifted game to read them and name lines.
   */
  async withVariableMap<T>(run: () => Promise<T>): Promise<T> {
    this.variableMaps++;
    try { return await run(); } finally { this.variableMaps--; }
  }

  /** Hear about the builds of the programs (on Save, Test Map and export): the log, and where a failure points. */
  onBuild(listener: (event: OwnBuildEvent) => void): { dispose(): void } {
    this.ownListeners.add(listener);
    return { dispose: () => { this.ownListeners.delete(listener); } };
  }

  /** The tables and the `.d.ts` for the open map — its forces, used locations, switch names, custom unit names and sounds. Null with no map. */
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
      // (A host from before the Sound Editor's API has no sounds() to ask.)
      sounds: (api.settings.sounds?.() ?? []).map((w) => ({ stringIndex: w.stringIndex, path: w.path })),
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
   * the editor keeps a copy that follows the map's events). With `sounds`, a build's: its
   * long clips encoded as Ogg Vorbis for the map, which a check as the user types does not wait for.
   */
  async prepare(input: ScriptInput, map: MapNames | null = this.names(), tests?: TestRunOptions, sounds = false): Promise<ScriptArtifact> {
    if (!map) throw new Error("No map is open.");
    const files = this.filesOf(input);
    const document = this.documentId();
    const archived = hashFiles(this.state()?.files ?? {});
    // (And whether TrigScript's own build takes the programs for this map: the apply writes the answer into the manifest.)
    const own = this.ownCheck();
    const compiled = await this.compiler({ files, names: map.names, ...(tests ? { tests } : {}), ...(sounds ? { sounds } : {}), ...(own ? { own } : {}) }, this.dist());
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
      const out = this.install(await this.prepare(input, undefined, undefined, true), options);
      if (out.refused !== "changed" || attempt >= 2) return out;
    }
  }

  /** Records as raw `trigger()` calls in the script language — what Import map triggers writes. */
  print(triggers: TriggerRecord[], options?: PrintOptions): string {
    const names = this.names()?.names ?? scriptNames();
    return printScript(triggers, { names, string: (i) => this.api.names.string(i) }, options);
  }

  /** The trigger interpreter over records, for `cycles` passes on the game's schedule (the first on frame 2, then every 31 frames, sooner when a Wait runs out): Deaths, Switch, Always, Never, Elapsed Time and the wait slots modelled, other conditions false, other actions logged with their pass and frame. */
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
