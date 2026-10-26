/**
 * The scenario file as a map of our own reads and writes it (TrigScript 4, step 14: the build in the editor). The
 * build takes the CHK the editor would save — the script applied, its `trigger()` records in the trigger list — and
 * gives back the one the game is to load: the programs' payload after the strings, the start-up in TRIG, a slot of
 * unit properties marked in transit when the players' input is read. Nothing of the editor's code is in reach of a
 * plugin, so the handful of sections the build touches are read and written here, byte for byte: the chunks, the
 * string table (STR or STRx), DIM, OWNR, FORC, UNIT, UPRP and UPUS. What the build does not touch is written back as
 * it came.
 */
import { ActionType, decodeTriggers, type TriggerRecord } from "../../vendor/triggers";

export interface Chunk { name: string; data: Uint8Array }

const latin1 = new TextDecoder("latin1");
const utf8 = new TextEncoder();

/**
 * The CHK's chunks in file order: a four-character name, a signed length, that many bytes. A chunk with a negative
 * length (a protected map's trick) ends the reading, as the game's does; what follows is `trailing`, written back as
 * it is.
 */
export function readChunks(bytes: Uint8Array): { chunks: Chunk[]; trailing: Uint8Array | null } {
  const chunks: Chunk[] = [];
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let pos = 0;
  while (pos + 8 <= bytes.length) {
    const name = latin1.decode(bytes.subarray(pos, pos + 4));
    const size = view.getInt32(pos + 4, true);
    if (size < 0) break;
    const end = Math.min(pos + 8 + size, bytes.length);
    chunks.push({ name, data: bytes.slice(pos + 8, end) });
    pos = end;
  }
  return { chunks, trailing: pos < bytes.length ? bytes.slice(pos) : null };
}

export function writeChunks(chunks: readonly Chunk[], trailing: Uint8Array | null = null): Uint8Array {
  const out = new Uint8Array(chunks.reduce((n, c) => n + 8 + c.data.length, 0) + (trailing?.length ?? 0));
  const view = new DataView(out.buffer);
  let pos = 0;
  for (const c of chunks) {
    for (let i = 0; i < 4; i++) out[pos + i] = (c.name.charCodeAt(i) || 32) & 0xff;
    view.setInt32(pos + 4, c.data.length, true);
    out.set(c.data, pos + 8);
    pos += 8 + c.data.length;
  }
  if (trailing) out.set(trailing, pos);
  return out;
}

/** The chunks as the build works on them: a name's last occurrence stands for it, as it does for the game. */
export class Sections {
  readonly chunks: Chunk[];
  readonly trailing: Uint8Array | null;

  constructor(bytes: Uint8Array) {
    const read = readChunks(bytes);
    this.chunks = read.chunks;
    this.trailing = read.trailing;
  }

  /** The last occurrence's bytes, or null. */
  get(name: string): Uint8Array | null {
    for (let i = this.chunks.length - 1; i >= 0; i--) if (this.chunks[i].name === name) return this.chunks[i].data;
    return null;
  }

  /** Every occurrence's bytes one after another: how the game reads a repeated TRIG. */
  all(name: string): Uint8Array {
    const parts = this.chunks.filter((c) => c.name === name).map((c) => c.data);
    if (parts.length === 1) return parts[0];
    const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let at = 0;
    for (const p of parts) { out.set(p, at); at += p.length; }
    return out;
  }

  /** Replace a name's last occurrence (the others, if any, are removed), or add it at the end. */
  set(name: string, data: Uint8Array): void {
    let last = -1;
    for (let i = this.chunks.length - 1; i >= 0; i--) if (this.chunks[i].name === name) { last = i; break; }
    if (last < 0) { this.chunks.push({ name, data }); return; }
    this.chunks[last] = { name, data };
    for (let i = last - 1; i >= 0; i--) if (this.chunks[i].name === name) this.chunks.splice(i, 1);
  }

  /** Put `name` where `old` is (the last occurrence), and take `old` out. */
  replace(old: string, name: string, data: Uint8Array): void {
    let last = -1;
    for (let i = this.chunks.length - 1; i >= 0; i--) if (this.chunks[i].name === old) { last = i; break; }
    if (last < 0) { this.set(name, data); return; }
    this.chunks[last] = { name, data };
    for (let i = this.chunks.length - 1; i >= 0; i--) if (this.chunks[i].name === old || (this.chunks[i].name === name && i !== last)) this.chunks.splice(i, 1);
  }

  bytes(): Uint8Array {
    return writeChunks(this.chunks, this.trailing);
  }
}

/**
 * The string table: `entries[i]` is string `i + 1`'s bytes, without the terminator; string 0 is no string. An STR
 * section counts and offsets in two bytes, an STRx (Remastered) in four, both from the section's start.
 */
export interface StringTable {
  entries: Uint8Array[];
}

export function readStrings(data: Uint8Array, extended: boolean): StringTable {
  const width = extended ? 4 : 2;
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  if (data.length < width) return { entries: [] };
  const count = extended ? view.getUint32(0, true) : view.getUint16(0, true);
  const entries: Uint8Array[] = [];
  for (let i = 0; i < count; i++) {
    const at = width * (1 + i);
    const offset = at + width <= data.length ? (extended ? view.getUint32(at, true) : view.getUint16(at, true)) : 0;
    if (!offset || offset >= data.length) { entries.push(new Uint8Array(0)); continue; }
    let end = offset;
    while (end < data.length && data[end] !== 0) end++;
    entries.push(data.slice(offset, end));
  }
  return { entries };
}

const same = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((x, i) => x === b[i]);

/** The 1-based index of a text among the strings — the first that holds these bytes, or a new one at the end. */
export function intern(table: StringTable, text: string): number {
  const bytes = utf8.encode(text);
  const i = table.entries.findIndex((e) => same(e, bytes));
  if (i >= 0) return i + 1;
  table.entries.push(bytes);
  return table.entries.length;
}

/** A string of the table's own, never shared: a new entry whatever the others hold. */
export function addString(table: StringTable, text: string): number {
  table.entries.push(utf8.encode(text));
  return table.entries.length;
}

/**
 * The table as an STRx section, each string's bytes once (two strings alike share an offset, as the editor writes
 * them), and where each string's bytes start — so that a template can be written over its own string
 * (`compiler/backend/build.ts`).
 */
export function writeStrings(table: StringTable): { data: Uint8Array; offsets: number[] } {
  const count = table.entries.length;
  const header = 4 * (1 + count);
  const placed = new Map<string, number>();
  const offsets: number[] = [];
  let size = header;
  for (const e of table.entries) {
    const key = latin1.decode(e);
    const at = placed.get(key);
    if (at !== undefined) { offsets.push(at); continue; }
    placed.set(key, size);
    offsets.push(size);
    size += e.length + 1;
  }
  const data = new Uint8Array(size);
  const view = new DataView(data.buffer);
  view.setUint32(0, count, true);
  const written = new Set<number>();
  table.entries.forEach((e, i) => {
    view.setUint32(4 * (1 + i), offsets[i], true);
    if (written.has(offsets[i])) return;
    written.add(offsets[i]);
    data.set(e, offsets[i]);
  });
  return { data, offsets };
}

/** The map's players as a map of our own needs them: who plays (OWNR 5 computer, 6 human) and in which force (FORC). */
export interface MapFacts {
  width: number;
  height: number;
  /** The slots a human or a computer plays, 0-based. */
  slots: number[];
  humans: number[];
  /** Each of the eight slots' force, 0-based. */
  forces: number[];
  /** The file's revision (VER). */
  version: number;
}

export function readFacts(s: Sections): MapFacts {
  const dim = s.get("DIM ");
  if (!dim || dim.length < 4) throw new Error("The map has no size (DIM).");
  const view = new DataView(dim.buffer, dim.byteOffset, dim.byteLength);
  const ownr = s.get("OWNR") ?? new Uint8Array(12);
  const forc = s.get("FORC") ?? new Uint8Array(20);
  const ver = s.get("VER ");
  const types = [...Array(8).keys()].map((p) => ownr[p] ?? 0);
  return {
    width: view.getUint16(0, true),
    height: view.getUint16(2, true),
    slots: [0, 1, 2, 3, 4, 5, 6, 7].filter((p) => types[p] === 5 || types[p] === 6),
    humans: [0, 1, 2, 3, 4, 5, 6, 7].filter((p) => types[p] === 6),
    forces: [0, 1, 2, 3, 4, 5, 6, 7].map((p) => forc[p] ?? 0),
    version: ver && ver.length >= 2 ? ver[0] | (ver[1] << 8) : 0,
  };
}

/** The map's own triggers, every TRIG occurrence read on as the game reads them. */
export function readTriggers(s: Sections): TriggerRecord[] {
  const trig = s.get("TRIG");
  return trig ? decodeTriggers(s.all("TRIG")) : [];
}

/** The unit types the map's placed units and its triggers name: a carrier of the players' input must be none of them. */
export function unitTypesUsed(s: Sections, triggers: readonly TriggerRecord[]): Set<number> {
  const used = new Set<number>();
  const unit = s.get("UNIT");
  if (unit) {
    const view = new DataView(unit.buffer, unit.byteOffset, unit.byteLength);
    for (let o = 0; o + 36 <= unit.length; o += 36) used.add(view.getUint16(o + 8, true));
  }
  for (const t of triggers) {
    for (const c of t.conditions) used.add(c.unitId);
    for (const a of t.actions) used.add(a.unitId);
  }
  return used;
}

export const CUWP_SLOTS = 64;
const CUWP_STRIDE = 20;
const IN_TRANSIT = 4;

/** The first unit-properties slot (1-based) no Create Unit with Properties of the map's triggers names. */
export function freeCuwpSlot(triggers: readonly TriggerRecord[]): number {
  const used = new Set<number>();
  for (const t of triggers) for (const a of t.actions) if (a.type === ActionType.CreateUnitWithProperties) used.add(a.target);
  for (let slot = 1; slot <= CUWP_SLOTS; slot++) if (!used.has(slot)) return slot;
  return CUWP_SLOTS;
}

/** The slot (1-based) marked in transit in UPRP — the carriers of the players' input are made with it — and in use in UPUS where the map has one. */
export function markInTransit(s: Sections, slot: number): void {
  const uprp = new Uint8Array(Math.max(CUWP_SLOTS * CUWP_STRIDE, s.get("UPRP")?.length ?? 0));
  const had = s.get("UPRP");
  if (had) uprp.set(had);
  const view = new DataView(uprp.buffer);
  const at = (slot - 1) * CUWP_STRIDE;
  view.setUint16(at, view.getUint16(at, true) | IN_TRANSIT, true);
  view.setUint16(at + 14, view.getUint16(at + 14, true) | IN_TRANSIT, true);
  s.set("UPRP", uprp);
  const upus = s.get("UPUS");
  if (upus && upus.length >= slot) { const next = upus.slice(); next[slot - 1] = 1; s.set("UPUS", next); }
}
