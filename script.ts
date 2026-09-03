/**
 * The trigger script as part of the map: its source and build manifest live as extra
 * archive members (`api.document.extras`), and the triggers it generated are a contiguous
 * *block* of the trigger list that the manifest points at.
 *
 * The block is identified by content, not just position: the manifest records the
 * block's start, length and a hash of its encoded records. `findBlock` looks for the
 * records at the recorded start and, failing that, anywhere in the list — so a hand
 * trigger inserted before the block in the Trigger Editor moves the block without
 * breaking it (`relocateManifest` then rewrites the manifest). Only an edit *inside*
 * the block makes it stale, in which case the next Build appends a fresh block and the
 * old records are left as ordinary hand triggers.
 *
 * Everything here is pure over a trigger list and a `Map` of the two members: the
 * plugin reads the map's extras into that shape and writes the result back (see
 * `plugin.ts`), the tests hand lists and maps in directly.
 */
import { ActionType, cloneTrigger, ConditionType, encodeTriggers, type TriggerRecord } from "./vendor/triggers";
import type { CompileOptions, CompileResult } from "./compiler/compiler";
import { defaultSwitchName } from "./compiler/names";

export const SCRIPT_MEMBER = "scmjs\\triggers.ts";
export const MANIFEST_MEMBER = "scmjs\\triggers.json";

export type Extras = ReadonlyMap<string, Uint8Array>;

export interface ScriptManifest {
  version: 1;
  /** Index of the first generated trigger. */
  start: number;
  count: number;
  /** `hashTriggers` of the generated records. */
  hash: string;
  /** Per generated trigger, the 1-based source line of its `trigger(` call. */
  lines: number[];
  /** `hashText` of the source the block was built from; absent in older manifests. */
  sourceHash?: string;
}

export interface ScriptBlock {
  start: number;
  count: number;
  lines: number[];
}

const decoder = new TextDecoder();
const encoder = new TextEncoder();

/** Member names compare without regard to case or slash direction, as the archive does. */
export const memberKey = (name: string) => name.replace(/\//g, "\\").toLowerCase();

/** Whether a member name is one of the two the script keeps. */
export function isScriptMember(name: string): boolean {
  const key = memberKey(name);
  return key === memberKey(SCRIPT_MEMBER) || key === memberKey(MANIFEST_MEMBER);
}

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

export function readScript(extras: Extras): string | null {
  const bytes = member(extras, SCRIPT_MEMBER);
  return bytes ? decoder.decode(bytes) : null;
}

export function withScript(extras: Extras, source: string | null): Map<string, Uint8Array> {
  return withMember(extras, SCRIPT_MEMBER, source === null ? null : encoder.encode(source));
}

export function readManifest(extras: Extras): ScriptManifest | null {
  const bytes = member(extras, MANIFEST_MEMBER);
  if (!bytes) return null;
  try {
    const m = JSON.parse(decoder.decode(bytes)) as Partial<ScriptManifest>;
    if (m.version !== 1 || typeof m.start !== "number" || typeof m.count !== "number" || typeof m.hash !== "string") return null;
    return { version: 1, start: m.start, count: m.count, hash: m.hash, lines: Array.isArray(m.lines) ? m.lines : [], sourceHash: typeof m.sourceHash === "string" ? m.sourceHash : undefined };
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

export function hashText(text: string): string {
  return fnv1a(encoder.encode(text));
}

/** Where the manifest's block actually is in the list, or null when its records are gone. */
export function findBlock(list: TriggerRecord[], manifest: ScriptManifest): ScriptBlock | null {
  const { start, count } = manifest;
  const at = (s: number) => s >= 0 && s + count <= list.length && hashTriggers(list.slice(s, s + count)) === manifest.hash;
  if (at(start)) return { start, count, lines: manifest.lines };
  if (count === 0) return { start: Math.min(start, list.length), count, lines: manifest.lines };
  for (let s = 0; s + count <= list.length; s++) if (s !== start && at(s)) return { start: s, count, lines: manifest.lines };
  return null;
}

export interface ScriptState {
  source: string | null;
  manifest: ScriptManifest | null;
  /** The generated block, when the manifest's records are still in the list. */
  block: ScriptBlock | null;
  /** A manifest exists but its records were edited or removed. */
  stale: boolean;
  /** The source differs from what the block was built from (or was never built). */
  unbuilt: boolean;
}

export function scriptState(triggers: TriggerRecord[] | null, extras: Extras): ScriptState {
  const source = readScript(extras);
  const manifest = readManifest(extras);
  const block = triggers && manifest ? findBlock(triggers, manifest) : null;
  const unbuilt = source !== null && (!manifest || manifest.sourceHash !== hashText(source));
  return { source, manifest, block, stale: !!manifest && !block, unbuilt };
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
 * block) and its switch names already use, so the structured program's variables are
 * allocated around them. The previous block's own records are not counted: a rebuild
 * replaces them. `switchNames` is the map's table with StarEdit's defaults in the blanks
 * (what `api.triggers.switchNames()` answers); a slot named anything else counts as used.
 */
export function reservedStorage(triggers: TriggerRecord[], switchNames: readonly (string | null)[], block: ScriptBlock | null): CompileOptions {
  const deaths = new Map<number, [number, number]>();
  const switches = new Set<number>();
  triggers.forEach((t, i) => {
    if (block && i >= block.start && i < block.start + block.count) return;
    for (const c of t.conditions) {
      if (c.type === ConditionType.Deaths) deaths.set(c.unitId * 4096 + c.player, [c.player, c.unitId]);
      else if (c.type === ConditionType.Switch) switches.add(c.resource);
    }
    for (const a of t.actions) {
      if (a.type === ActionType.SetDeaths) deaths.set(a.unitId * 4096 + a.player, [a.player, a.unitId]);
      else if (a.type === ActionType.SetSwitch) switches.add(a.target);
    }
  });
  switchNames.forEach((s, i) => { if (s && s.trim() && s.trim() !== defaultSwitchName(i)) switches.add(i); });
  return { reservedDeaths: [...deaths.values()], reservedSwitches: [...switches].sort((a, b) => a - b) };
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
}

export interface BuildPlan {
  /** The trigger list as it should be after the build. */
  list: TriggerRecord[];
  /** The two members as they should be after the build. */
  extras: Map<string, Uint8Array>;
  block: ScriptBlock;
}

/**
 * Plan a successful compile's installation: the list with the current block replaced
 * (or a new one appended), and the source and manifest to store. `intern` answers the
 * string-table index for a text — inside a `document.update`, that is `tx.strings.intern`.
 */
export function buildScript(triggers: TriggerRecord[], extras: Extras, source: string, compiled: CompileResult, intern: (text: string) => number, options: BuildOptions = {}): BuildPlan {
  const records = resolveStrings(compiled, intern);
  const state = scriptState(triggers, extras);
  let start: number;
  let before: TriggerRecord[];
  let after: TriggerRecord[];
  if (options.takeOver) {
    start = 0; before = []; after = [];
  } else if (state.block) {
    start = state.block.start;
    before = triggers.slice(0, start);
    after = triggers.slice(start + state.block.count);
  } else {
    start = triggers.length; before = triggers.slice(); after = [];
  }
  const manifest: ScriptManifest = { version: 1, start, count: records.length, hash: hashTriggers(records), lines: compiled.lines, sourceHash: hashText(source) };
  return { list: [...before, ...records, ...after], extras: withManifest(withScript(extras, source), manifest), block: { start, count: records.length, lines: manifest.lines } };
}

/** Which trigger a source line belongs to (the trigger whose call starts at or before the line), if any. */
export function triggerAtLine(block: ScriptBlock, line: number): number | null {
  let hit: number | null = null;
  block.lines.forEach((l, i) => { if (l <= line) hit = block.start + i; });
  return hit;
}
