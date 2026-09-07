/**
 * The script as part of the map: its files and build manifest live as extra archive
 * members under `trigscript\` (`api.document.extras`), and the triggers it generated
 * are a contiguous *block* of the trigger list that the manifest points at.
 *
 * The block is identified by content, not just position: the manifest records the
 * block's start, length and a hash of its encoded records. `findBlock` looks for the
 * records at the recorded start and, failing that, anywhere in the list — so a hand
 * trigger inserted before the block in the Trigger Editor moves the block without
 * breaking it (`relocateManifest` then rewrites the manifest). Only an edit *inside*
 * the block makes it stale. The manifest also hashes every record on its own, so a
 * stale block can still be told apart record by record: the next Build can replace the
 * records that are still the build's and keep only the edited ones as hand triggers
 * (`replaceStale`), or append a fresh block and leave them all.
 *
 * Everything here is pure over a trigger list and a `Map` of the members: the plugin
 * reads the map's extras into that shape and writes the result back (see `service.ts`),
 * the tests hand lists and maps in directly.
 */
import { cloneTrigger, encodeTriggers, type TriggerRecord } from "./vendor/triggers";
import { ENTRY_FILE, normalizePath, type CompileOptions, type CompileResult, type ScriptFiles, type TriggerSource } from "./compiler/compiler";
import { defaultSwitchName } from "./compiler/names";
import { storageOf } from "./compiler/reserve";

/** The archive folder the script's files live in, next to `staredit\`. */
export const SCRIPT_FOLDER = "trigscript\\";
export const MANIFEST_MEMBER = `${SCRIPT_FOLDER}build.json`;
/** The entry file's member name. */
export const ENTRY_MEMBER = `${SCRIPT_FOLDER}${ENTRY_FILE}`;

export type Extras = ReadonlyMap<string, Uint8Array>;

export interface ScriptManifest {
  version: 2;
  /** Index of the first generated trigger. */
  start: number;
  count: number;
  /** `hashTriggers` of the generated records. */
  hash: string;
  /** Per generated trigger, where it came from; null for a hyper trigger. */
  sources: (TriggerSource | null)[];
  /** Every file the block was built from, by path — so a protected map with no listfile still gives them up by name. */
  files: string[];
  /** `hashFiles` of the files the block was built from. */
  sourceHash: string;
  /** `hashRecord` of each generated record, so an edited block can be taken apart; absent in a manifest from before 2.4.1. */
  records?: string[];
}

export interface ScriptBlock {
  start: number;
  count: number;
  sources: (TriggerSource | null)[];
}

const decoder = new TextDecoder();
const encoder = new TextEncoder();

/** Member names compare without regard to case or slash direction, as the archive does. */
export const memberKey = (name: string) => name.replace(/\//g, "\\").toLowerCase();

/** Whether a member name is one of the script's: anything under its folder. */
export function isScriptMember(name: string): boolean {
  return memberKey(name).startsWith(memberKey(SCRIPT_FOLDER));
}

/** The member name of a script file (`ai/waves.ts` → `trigscript\ai\waves.ts`). */
export function memberOf(path: string): string {
  return `${SCRIPT_FOLDER}${normalizePath(path).replace(/\//g, "\\")}`;
}

/** The script path of a member under the folder, or null for anything else (the manifest included). */
export function pathOf(member: string): string | null {
  if (!isScriptMember(member)) return null;
  const rest = member.replace(/\//g, "\\").slice(SCRIPT_FOLDER.length);
  return /\.ts$/i.test(rest) ? rest.replace(/\\/g, "/") : null;
}

/** A file name a script may use: letters, digits, `_`, `-`, `.`, folders with `/`, ending in `.ts`. */
export const FILE_NAME = /^(?:[A-Za-z0-9_\-.]+\/)*[A-Za-z0-9_\-.]+\.ts$/;

function member(extras: Extras, name: string): Uint8Array | undefined {
  const key = memberKey(name);
  for (const [k, v] of extras) if (memberKey(k) === key) return v;
  return undefined;
}

function withMember(extras: Extras, name: string, data: Uint8Array | null): Map<string, Uint8Array> {
  const next = new Map(extras);
  const key = memberKey(name);
  for (const k of next.keys()) if (memberKey(k) === key) next.delete(k);
  if (data) next.set(name, data);
  return next;
}

/** The script's files, by path; empty when the map has none. */
export function readFiles(extras: Extras): ScriptFiles {
  const out: ScriptFiles = {};
  for (const [name, bytes] of extras) {
    const path = pathOf(name);
    if (path) out[path] = decoder.decode(bytes);
  }
  return out;
}

/** The members with the script's files replaced by these (a file not in `files` is removed). */
export function withFiles(extras: Extras, files: ScriptFiles): Map<string, Uint8Array> {
  const next = new Map<string, Uint8Array>();
  for (const [name, bytes] of extras) if (!pathOf(name)) next.set(name, bytes);
  for (const [path, text] of Object.entries(files)) next.set(memberOf(path), encoder.encode(text));
  return next;
}

export function readManifest(extras: Extras): ScriptManifest | null {
  const bytes = member(extras, MANIFEST_MEMBER);
  if (!bytes) return null;
  try {
    const m = JSON.parse(decoder.decode(bytes)) as Partial<ScriptManifest>;
    if (m.version !== 2 || typeof m.start !== "number" || typeof m.count !== "number" || typeof m.hash !== "string") return null;
    const sources = Array.isArray(m.sources) ? m.sources.map((s) => (s && typeof s === "object" && typeof s.file === "string" && typeof s.line === "number" ? { file: s.file, line: s.line } : null)) : [];
    const files = Array.isArray(m.files) ? m.files.filter((f): f is string => typeof f === "string") : [];
    const records = Array.isArray(m.records) && m.records.length === m.count && m.records.every((r) => typeof r === "string") ? m.records : undefined;
    return { version: 2, start: m.start, count: m.count, hash: m.hash, sources, files, sourceHash: typeof m.sourceHash === "string" ? m.sourceHash : "", ...(records ? { records } : {}) };
  } catch {
    return null;
  }
}

export function withManifest(extras: Extras, manifest: ScriptManifest | null): Map<string, Uint8Array> {
  return withMember(extras, MANIFEST_MEMBER, manifest ? encoder.encode(JSON.stringify(manifest)) : null);
}

function fnv1a(bytes: Uint8Array): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i++) {
    h ^= bytes[i];
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

/** FNV-1a over the encoded records, prefixed with the count. */
export function hashTriggers(list: TriggerRecord[]): string {
  return `${list.length}:${fnv1a(encodeTriggers(list))}`;
}

/** FNV-1a over one encoded record. */
export function hashRecord(t: TriggerRecord): string {
  return fnv1a(encodeTriggers([t]));
}

export function hashText(text: string): string {
  return fnv1a(encoder.encode(text));
}

/** One hash over every file, by path, so a change to any of them counts. */
export function hashFiles(files: ScriptFiles): string {
  const paths = Object.keys(files).map(normalizePath).sort();
  return hashText(paths.map((p) => `${p}\0${files[p] ?? ""}\0`).join(""));
}

/** Where the manifest's block actually is in the list, or null when its records are gone. */
export function findBlock(list: TriggerRecord[], manifest: ScriptManifest): ScriptBlock | null {
  const { start, count } = manifest;
  const at = (s: number) => s >= 0 && s + count <= list.length && hashTriggers(list.slice(s, s + count)) === manifest.hash;
  if (at(start)) return { start, count, sources: manifest.sources };
  if (count === 0) return { start: Math.min(start, list.length), count, sources: manifest.sources };
  for (let s = 0; s + count <= list.length; s++) if (s !== start && at(s)) return { start: s, count, sources: manifest.sources };
  return null;
}

/** A stale block taken apart: the indices at the manifest's start whose records are still the build's, and those that were edited. */
export interface StaleRecords {
  unchanged: number[];
  changed: number[];
}

/**
 * When the block is stale, which of the records at the manifest's start are still the
 * build's own, by their individual hashes. Null when the manifest has none (an older
 * build), or none of them is still there (the block was removed or moved, not edited).
 */
export function staleRecords(list: TriggerRecord[], manifest: ScriptManifest): StaleRecords | null {
  if (!manifest.records) return null;
  const out: StaleRecords = { unchanged: [], changed: [] };
  for (let i = 0; i < manifest.count; i++) {
    const at = manifest.start + i;
    if (at >= list.length) break;
    (hashRecord(list[at]) === manifest.records[i] ? out.unchanged : out.changed).push(at);
  }
  return out.unchanged.length ? out : null;
}

export interface ScriptState {
  /** The script's files; null when the map has none. */
  files: ScriptFiles | null;
  /** The entry file's text, for callers that deal in one file; null when there is none. */
  source: string | null;
  manifest: ScriptManifest | null;
  /** The generated block, when the manifest's records are still in the list. */
  block: ScriptBlock | null;
  /** A manifest exists but its records were edited or removed. */
  stale: boolean;
  /** A stale block the next build can take apart: how many records are still the build's, how many were edited. Null when it cannot. */
  edited: { unchanged: number; changed: number } | null;
  /** The files differ from what the block was built from (or were never built). */
  unbuilt: boolean;
}

export function scriptState(triggers: TriggerRecord[] | null, extras: Extras): ScriptState {
  const read = readFiles(extras);
  const files = Object.keys(read).length ? read : null;
  const manifest = readManifest(extras);
  const block = triggers && manifest ? findBlock(triggers, manifest) : null;
  const unbuilt = files !== null && (!manifest || manifest.sourceHash !== hashFiles(files));
  const stale = !!manifest && !block;
  const parts = stale && triggers ? staleRecords(triggers, manifest!) : null;
  return { files, source: files?.[ENTRY_FILE] ?? null, manifest, block, stale, edited: parts ? { unchanged: parts.unchanged.length, changed: parts.changed.length } : null, unbuilt };
}

export function isGenerated(state: ScriptState, index: number): boolean {
  return !!state.block && index >= state.block.start && index < state.block.start + state.block.count;
}

/** After another editor rewrote the list: point the manifest at where the block went. Null when nothing changed. */
export function relocateManifest(triggers: TriggerRecord[], extras: Extras): Map<string, Uint8Array> | null {
  const manifest = readManifest(extras);
  if (!manifest) return null;
  const block = findBlock(triggers, manifest);
  if (!block || block.start === manifest.start) return null;
  return withManifest(extras, { ...manifest, start: block.start });
}

/**
 * The death counters and switches the map's hand triggers (those outside the script's
 * block) and its switch names already use, so the programs' variables are allocated
 * around them. The previous block's own records are not counted: a rebuild replaces
 * them. A player group in a record stands for every slot it can mean (`storageOf`).
 * `switchNames` is the map's table with StarEdit's defaults in the blanks (what
 * `api.triggers.switchNames()` answers); a slot named anything else counts as used.
 */
export function reservedStorage(triggers: TriggerRecord[], switchNames: readonly (string | null)[], block: ScriptBlock | null): Pick<CompileOptions, "reservedDeaths" | "reservedSwitches"> {
  const hand = triggers.filter((_, i) => !(block && i >= block.start && i < block.start + block.count));
  const used = storageOf(hand);
  const switches = new Set<number>(used.switches);
  switchNames.forEach((s, i) => { if (s && s.trim() && s.trim() !== defaultSwitchName(i)) switches.add(i); });
  return { reservedDeaths: used.deaths, reservedSwitches: [...switches].sort((a, b) => a - b) };
}

/** The compiled records with their local string ids resolved through `intern` (the map's string table). */
export function resolveStrings(compiled: CompileResult, intern: (text: string) => number): TriggerRecord[] {
  const cache = new Map<number, number>();
  const resolve = (local: number): number => {
    if (local === 0) return 0;
    const hit = cache.get(local);
    if (hit !== undefined) return hit;
    const s = compiled.strings[local - 1];
    const index = !s ? 0 : "index" in s ? s.index : intern(s.text);
    cache.set(local, index);
    return index;
  };
  return compiled.triggers.map((t) => {
    const next = cloneTrigger(t);
    for (const a of next.actions) {
      a.text = resolve(a.text);
      a.wav = resolve(a.wav);
    }
    return next;
  });
}

export interface BuildOptions {
  /** Replace the *whole* list with the script's triggers (ejecting every hand trigger into the block). */
  takeOver?: boolean;
  /**
   * Leave the archive's files as they are instead of storing the compiled ones: they were
   * edited while the compile ran, and the newer text must not be overwritten by the older.
   * The manifest still records what the block was built from, so the state reads as unbuilt.
   */
  keepFiles?: boolean;
  /**
   * The previous block was edited by hand (`ScriptState.stale`): remove the records that
   * are still the build's own and put the new block in their place, keeping the edited
   * records as hand triggers right after it. Without it, the new block is appended and
   * the old records all stay.
   */
  replaceStale?: boolean;
}

export interface BuildPlan {
  /** The trigger list as it should be after the build. */
  list: TriggerRecord[];
  /** The members as they should be after the build. */
  extras: Map<string, Uint8Array>;
  block: ScriptBlock;
  /** With `replaceStale`: how many of the previous block's records were removed, and how many edited ones kept. */
  replaced?: { removed: number; kept: number };
}

/**
 * Plan a successful compile's installation: the list with the current block replaced
 * (or a new one appended), and the files and manifest to store. `intern` answers the
 * string-table index for a text — inside a `document.update`, that is `tx.strings.intern`.
 */
export function buildScript(triggers: TriggerRecord[], extras: Extras, files: ScriptFiles, compiled: CompileResult, intern: (text: string) => number, options: BuildOptions = {}): BuildPlan {
  const records = resolveStrings(compiled, intern);
  const state = scriptState(triggers, extras);
  let start: number;
  let before: TriggerRecord[];
  let after: TriggerRecord[];
  let replaced: BuildPlan["replaced"];
  const parts = options.replaceStale && state.stale && state.manifest ? staleRecords(triggers, state.manifest) : null;
  if (options.takeOver) {
    start = 0; before = []; after = [];
  } else if (state.block) {
    start = state.block.start;
    before = triggers.slice(0, start);
    after = triggers.slice(start + state.block.count);
  } else if (parts) {
    // The edited records stay, as hand triggers right after the new block; the untouched ones go.
    start = state.manifest!.start;
    const end = Math.min(triggers.length, start + state.manifest!.count);
    before = triggers.slice(0, start);
    after = [...parts.changed.map((i) => triggers[i]), ...triggers.slice(end)];
    replaced = { removed: parts.unchanged.length, kept: parts.changed.length };
  } else {
    start = triggers.length; before = triggers.slice(); after = [];
  }
  const manifest: ScriptManifest = { version: 2, start, count: records.length, hash: hashTriggers(records), sources: compiled.sources, files: Object.keys(files).map(normalizePath).sort(), sourceHash: hashFiles(files), records: records.map(hashRecord) };
  return { list: [...before, ...records, ...after], extras: withManifest(options.keepFiles ? extras : withFiles(extras, files), manifest), block: { start, count: records.length, sources: manifest.sources }, ...(replaced ? { replaced } : {}) };
}

/** Which trigger a source line of a file belongs to (the trigger whose source starts at or before the line), if any. */
export function triggerAtLine(block: ScriptBlock, file: string, line: number): number | null {
  let hit: number | null = null;
  const path = normalizePath(file);
  block.sources.forEach((s, i) => { if (s && normalizePath(s.file) === path && s.line <= line) hit = block.start + i; });
  return hit;
}
