/**
 * The script service: everything the plugin does to the map, shared by the commands it
 * publishes and by the editor dialog. It reads the script's members through
 * `api.document.extras`, the map's names through `api.settings` / `api.names` /
 * `api.query`, compiles through `compile.ts`, and installs a build with one
 * `document.update` — a settings-style transaction, outside the undo model, exactly as
 * the editor's own trigger dialogs write.
 */
import type { PluginApi, TriggerClaimHandle } from "@scm-js/plugin-api";
import type { TriggerRecord } from "./vendor/triggers";
import { compileInBackground, type CompileInput } from "./compile";
import { ENTRY_FILE, type CompileResult, type ScriptDiagnostic, type ScriptFiles } from "./compiler/compiler";
import { generateDeclarations } from "./compiler/declarations";
import { checkForTarget, serializeIr } from "./compiler/eud";
import { TRIGSCRIPT_PY } from "./compiler/generated/trigscriptPy";
import { scriptNames, type ScriptNames } from "./compiler/names";
import { printScript, type PrintOptions } from "./compiler/print";
import { simulate, type SimulationEvent } from "./compiler/simulate";
import { DEFAULT_DIST, DIST_STORAGE_KEY } from "./monaco";
import {
  buildScript, findBlock, hashFiles, hashText, isScriptMember, readManifest, readTarget, relocateManifest, reservedStorage, scriptState, stringResolver, triggerAtLine, withFiles, withTarget,
  type BuildOptions, type BuildTarget, type Extras, type ScriptBlock, type ScriptState,
} from "./script";
import { EUDPLIB_SERVICE, type EudplibService } from "./vendor/eudplib";

/**
 * A compile, with what it was compiled *for*: the map it read its names from and the
 * state those names were in. Installing checks both, so a build lands only on the map
 * and the names it was made against — another map in front by the time the worker
 * answers, or a location renamed meanwhile, is refused rather than installed.
 */
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
  /** With `ir`: the programs as JSON for the eudplib plugin, the map's string indices in place of the compile's local ones. */
  ir?: string;
}

/** What a Remastered build made: the built map's bytes and the log. */
export interface EudBuild {
  map: Uint8Array;
  log: string;
  chkBytes: number;
  ms: number;
}

/** The eudplib plugin refused or failed a build; `at` when the message named a node of the IR. */
export class EudBuildError extends Error {
  readonly at: { file: string; line: number; column: number } | null;
  constructor(message: string) {
    super(message);
    this.name = "EudBuildError";
    const m = /\bat (?:([^\s:]+\.ts):)?(\d+):(\d+)\b/.exec(message);
    this.at = m ? { file: m[1] ?? ENTRY_FILE, line: Number(m[2]), column: Number(m[3]) } : null;
  }
}

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
  /** Storage the map's hand triggers already use, for the allocator to avoid. */
  reservedDeaths: readonly (readonly [number, number])[];
  reservedSwitches: readonly number[];
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
        return `This trigger is generated by the map's TrigScript${at ? ` (${at.file}, line ${at.line})` : ""}. Edit the source instead; a Build replaces the whole block.`;
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

  /** The target the open map's script is written for; classic with no map. */
  target(): BuildTarget {
    if (!this.api.document.isOpen()) return "classic";
    return readTarget(snapshotExtras(this.api));
  }

  /** Record the target in `build.json` (marks the map modified when it changes). */
  setTarget(target: BuildTarget): void {
    if (!this.api.document.isOpen() || this.target() === target) return;
    const before = snapshotExtras(this.api);
    commitExtras(this.api, before, withTarget(before, target));
  }

  /** The eudplib plugin's service, or null when it is not installed or is off. */
  library(): EudplibService | null {
    return this.api.services.get<EudplibService>(EUDPLIB_SERVICE);
  }

  /** Called at once and whenever the eudplib plugin arrives or goes. */
  watchLibrary(listener: (service: EudplibService | null) => void): { dispose(): void } {
    return this.api.services.watch<EudplibService>(EUDPLIB_SERVICE, (s) => listener(s));
  }

  /** What a target cannot take in a compile's programs, as diagnostics the editor shows like the compiler's own. */
  targetDiagnostics(compiled: CompileResult, target: BuildTarget): ScriptDiagnostic[] {
    const out: ScriptDiagnostic[] = [];
    for (const p of compiled.ir) {
      for (const d of checkForTarget(p, target)) out.push({ file: d.at.file, line: d.at.line, column: d.at.column, endLine: d.at.line, endColumn: d.at.column + 1, message: d.message, source: "compiler" });
    }
    return out;
  }

  /**
   * The Remastered build: the map as it stands (the classic block just installed, so
   * every text the IR names is in it), the IR, and `python/trigscript.py` to the eudplib
   * plugin's service. The library asks to download its runtime the first time. Throws
   * `EudBuildError`, with the IR node's position when the lowering named one.
   */
  async buildRemastered(ir: string, options: { onLog?: (line: string) => void; signal?: AbortSignal } = {}): Promise<EudBuild> {
    const svc = this.library();
    if (!svc) throw new EudBuildError("The eudplib plugin is not running; install or turn it on under Plugins ▸ Manage Plugins….");
    if (!(await svc.ensure({ reason: "TrigScript needs it to build this map for StarCraft: Remastered." }))) throw new EudBuildError("Not built: the build runtime was not installed.");
    const file = await this.api.document.export();
    if (!file) throw new EudBuildError("No map is open.");
    const map = new Uint8Array(await file.arrayBuffer());
    try {
      const r = await svc.build(
        { map, plugins: { trigscript: { ir: "/work/files/trigscript.json" }, eudTurbo: {} }, sources: { trigscript: TRIGSCRIPT_PY }, files: { "trigscript.json": ir } },
        { onLog: options.onLog, signal: options.signal },
      );
      return { map: r.map, log: r.log, chkBytes: r.chkBytes, ms: r.ms };
    } catch (err) {
      throw err instanceof EudBuildError ? err : new EudBuildError(String((err as Error).message ?? err));
    }
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
    const triggers = api.triggers.list();
    const state = scriptState(triggers, snapshotExtras(api));
    const reserved = reservedStorage(triggers, switchNames, state.block);
    const decls = generateDeclarations(names);
    const reservedDeaths = reserved.reservedDeaths ?? [];
    const reservedSwitches = reserved.reservedSwitches ?? [];
    return { names, decls, reservedDeaths, reservedSwitches, context: hashText(`${decls}\0${JSON.stringify([reservedDeaths, reservedSwitches])}`) };
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
  async prepare(input: ScriptInput, map: MapNames | null = this.names()): Promise<ScriptArtifact> {
    if (!map) throw new Error("No map is open.");
    const files = this.filesOf(input);
    const document = this.documentId();
    const archived = hashFiles(this.state()?.files ?? {});
    const compiled = await this.compiler({ files, names: map.names, reservedDeaths: map.reservedDeaths, reservedSwitches: map.reservedSwitches }, this.dist());
    return { files, compiled, document, context: map.context, archived };
  }

  /**
   * Install an artifact as the block — replacing the previous one, or appending when the
   * previous was edited by hand — and store its files with the map, in one
   * `document.update`. Refused, with the reason, when it has errors or the map it was
   * compiled for is not the one in front any more (closed, switched, or changed under
   * it). Files edited in the archive since the compile started are left as they are.
   * `takeOver` replaces the whole trigger list with the script's.
   */
  install(artifact: ScriptArtifact, options: BuildOptions & { ir?: boolean } = {}): ScriptBuildResult {
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
    let ir: string | undefined;
    this.api.document.update("Build TrigScript", (tx) => {
      const before = snapshotExtras(this.api);
      const intern = (text: string) => tx.strings.intern(text);
      const plan = buildScript(tx.triggers.list(), before, files, compiled, intern, { ...options, keepFiles });
      tx.triggers.set(plan.list);
      commitExtras(this.api, before, plan.extras);
      block = plan.block;
      replaced = plan.replaced;
      // The same interning as the block's records, so the IR's texts are the strings the map now holds.
      if (options.ir) ir = serializeIr(compiled.ir, stringResolver(compiled, intern));
    });
    this.claim.refresh();
    if (block) {
      const b: ScriptBlock = block;
      this.api.ui.status(b.count === 0 ? "Built: the script defines no triggers." : `Built ${b.count} trigger${b.count === 1 ? "" : "s"} → #${b.start + 1}–#${b.start + b.count}.`);
    }
    return { compiled, block, ...(replaced ? { replaced } : {}), ...(ir !== undefined ? { ir } : {}) };
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

  /** The files as typed, straight into the archive (the map is modified; only Build changes triggers). */
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
