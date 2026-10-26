/**
 * Where a built map keeps each program's variables, and reading them back out of the game's memory (TrigScript 4,
 * A2): `sim.program()` for a test that runs in the lifted game. The lowering says where every cell is when the build
 * asks it to (the `variableMap` setting of `python/trigscript.py`), in lines of the build's log; this reads those
 * lines, and reads a program's variables by the names in the source as the simulator's `ProgramRun.lookup` does.
 *
 * Two things differ from the simulator, both because the game has every cell from the start: a variable not yet
 * declared reads as its zero rather than as missing, and of two declarations with one name the later in the source
 * wins rather than the later to run. A list inside a list and a row of a grid are not read (a record of them is).
 */
import type { SimUnit } from "./world";

export interface GameVariable {
  id: string;
  kind: "number" | "boolean" | "unit" | "text";
  /** How a text is kept: `id` a string of the table, `made` characters somewhere in memory. */
  text?: "id" | "made" | null;
  bits?: 8 | 16 | null;
  unsigned: boolean;
  /** A per-player program's own: each cell is a row of twelve, one a player. */
  rowed: boolean;
  /** The address of each of its cells (`value`; `addr` + `len`; `ptr` + `uid`), null for one nothing in the map uses. */
  cells: Record<string, number | null>;
  /** Bytes from a row's cell to the next (4; 72 where the rows are an EUDVArray, a variable each); 4 when not said. */
  stride?: number;
  /** A map of our own keeps a unit's `ptr` and a made text's `addr` as EPDs (dwords from the deaths table), not addresses. */
  epd?: boolean;
  /** A map of our own keeps a text of the table as its number in the pool of texts known when built: the table's string `textBase` + it. */
  textBase?: number;
}

/** The deaths table: what an EPD counts dwords from. */
const DEATHS = 0x58a364;

export interface GameArray {
  id: string;
  kind: "number" | "boolean";
  bits?: 8 | 16 | null;
  unsigned: boolean;
  length: number;
  rowed: boolean;
  /** Where the cells are; or, of one that grows, its handle's `ptr` (its block among the heap's cells) and `len`. */
  at?: number | null;
  dynamic?: boolean;
  ptr?: number | null;
  len?: number | null;
  /** Bytes from a cell to the next, or from a row's handle to the next (4; 72 for an EUDVArray); 4 when not said. */
  stride?: number;
}

export interface GameProgramPlaces {
  index: number;
  name?: string | null;
  perPlayer: boolean;
  owners: number[];
  vars: GameVariable[];
  arrays: GameArray[];
}

export interface VariableMap {
  /** The heap's first cell, where made texts keep theirs; null when nothing grows. */
  heap: number | null;
  /**
   * Where the growing arrays' first cell keeps its value: an EUDVArray as long as the heap (blocks are handed out of
   * both alike), 72 bytes a cell; null when nothing grows (or the build kept them on the heap, as 3.x did).
   */
  cells?: number | null;
  /** Where the map's strings are: a text of the table is read through it. */
  strings: number;
  programs: GameProgramPlaces[];
}

const HEAD = "TRIGSCRIPT-VARS ", PROGRAM = "TRIGSCRIPT-PROGRAM ";

/** A line of the build's log that is for a run in the lifted game and not for a person (the trigger map's too). */
export const isMachineLine = (line: string): boolean => /^TRIGSCRIPT-[A-Z]+ /.test(line);

/** The variable map in a build's log; null when the build did not say one (or said it cut short). */
export function readVariableMap(lines: Iterable<string>): VariableMap | null {
  let head: { programs: number; heap: number | null; cells?: number | null; strings: number } | null = null;
  const programs: GameProgramPlaces[] = [];
  for (const line of lines) {
    if (line.startsWith(HEAD)) head = JSON.parse(line.slice(HEAD.length));
    else if (line.startsWith(PROGRAM)) programs.push(JSON.parse(line.slice(PROGRAM.length)));
  }
  if (!head || programs.length !== head.programs) return null;
  return { heap: head.heap, ...(head.cells != null ? { cells: head.cells } : {}), strings: head.strings, programs: programs.sort((a, b) => a.index - b.index) };
}

/** Where cell `i` of a growing array's block (`ptr`, its place among the cells) keeps its value; null when nothing grows. */
export function listCellAt(map: VariableMap, ptr: number, i: number): number | null {
  if (map.cells != null) return map.cells + 72 * (ptr + i);
  return map.heap == null ? null : map.heap + 4 * (ptr + i);
}

/** What reading needs of the game: its memory, and a unit by its pointer and the uniqueness byte kept with it. */
export interface VariableReader {
  m: DataView;
  u8: Uint8Array;
  unitAt(ptr: number, uid: number): SimUnit | null;
}

const MOST_TEXT = 1 << 16;
const utf8 = new TextDecoder();

/** The program's variables by their names in the source, as `TestSim.program()` gives them. Throws for no such program. */
export function programVariables(game: VariableReader, map: VariableMap, name: string | number = 0, player?: number): Record<string, unknown> {
  const p = map.programs.find((x) => (typeof name === "number" ? x.index === name : x.name === name) && (player === undefined || x.owners.includes(player)));
  if (!p) {
    const known = [...new Set(map.programs.map((x) => x.name).filter(Boolean))];
    throw new Error(typeof name === "number"
      ? `There is no program ${name}: the script has ${map.programs.length}.`
      : `There is no program named "${name}"${player !== undefined ? ` that runs for P${player + 1}` : ""}. ${known.length ? `Named: ${known.join(", ")}.` : "A program is named by its option: program(() => { … }, { name: \"waves\" })."}`);
  }
  const who = player ?? p.owners[0] ?? 0;
  const { m, u8 } = game;
  const raw = (at: number | null | undefined, rowed: boolean, stride = 4): number => (at == null ? 0 : m.getUint32(rowed ? at + stride * who : at, true));
  const num = (v: number, t: { kind: string; bits?: number | null; unsigned: boolean }): number | boolean => (t.kind === "boolean" ? v !== 0 : t.bits || t.unsigned ? v >>> 0 : v | 0);
  const cString = (at: number): string => { let end = at; while (end < u8.length && end - at < MOST_TEXT && u8[end] !== 0) end++; return utf8.decode(u8.subarray(at, end)); };
  // (A map of our own keeps where a unit or a made text is as an EPD: the address is the deaths table's plus four times it.)
  const where = (v: GameVariable, cell: number | null | undefined): number => { const x = raw(cell, v.rowed, v.stride); return x && v.epd ? (DEATHS + 4 * x) >>> 0 : x; };
  const text = (v: GameVariable): string => {
    if (v.text === "made") { const at = where(v, v.cells.addr); return at ? cString(at) : ""; }
    const id = raw(v.cells.value, v.rowed, v.stride) + (v.textBase ?? 0);
    return id ? cString(map.strings + m.getUint32(map.strings + 4 * id, true)) : "";
  };
  const value = (v: GameVariable): unknown => {
    // (A map of our own keeps the uniqueness byte itself; a build through eudplib kept the word it sits in, the byte above.)
    if (v.kind === "unit") { const ptr = where(v, v.cells.ptr); const uid = raw(v.cells.uid, v.rowed, v.stride); return ptr ? game.unitAt(ptr, v.epd ? uid << 8 : uid) : null; }
    if (v.kind === "text") return text(v);
    return num(raw(v.cells.value, v.rowed, v.stride), v);
  };
  const cells = (a: GameArray): (number | boolean)[] => {
    if (a.dynamic) {
      if (map.heap == null && map.cells == null) return [];
      const ptr = raw(a.ptr, a.rowed, a.stride), n = Math.min(raw(a.len, a.rowed, a.stride), MOST_TEXT);
      return Array.from({ length: n }, (_, i) => num(m.getUint32(listCellAt(map, ptr, i)!, true), a));
    }
    if (a.at == null) return new Array(a.length).fill(num(0, a));
    const row = a.rowed ? who * a.length : 0;
    const stride = a.stride ?? 4;
    return Array.from({ length: a.length }, (_, i) => num(m.getUint32(a.at! + stride * (row + i), true), a));
  };

  // As the simulator looks a name up: a number or a boolean, a text, an array, a unit, then a record of fields.
  const named = (id: string, n: string) => id === n || id.startsWith(`${n}#`);
  const last = <T extends { id: string }>(xs: T[], n: string): T | undefined => { let found: T | undefined; for (const x of xs) if (named(x.id, n)) found = x; return found; };
  const lookup = (n: string): unknown => {
    const plain = last(p.vars.filter((v) => v.kind === "number" || v.kind === "boolean"), n);
    if (plain) return value(plain);
    const t = last(p.vars.filter((v) => v.kind === "text"), n);
    if (t) return text(t);
    const a = last(p.arrays, n);
    if (a) return cells(a);
    const u = last(p.vars.filter((v) => v.kind === "unit"), n);
    if (u) return value(u);
    const field = (id: string) => (id.startsWith(`${n}.`) ? id.slice(n.length + 1).split("#")[0] : null);
    const record: Record<string, unknown> = {};
    for (const v of p.vars) { const f = field(v.id); if (f && v.kind !== "unit" && !(v.kind !== "text" && f.includes(" ("))) record[f] = value(v); }
    if (Object.keys(record).length) return record;
    const rows: Record<string, unknown>[] = [];
    for (const arr of p.arrays) { const f = field(arr.id); if (f) cells(arr).forEach((cell, i) => { (rows[i] ??= {})[f] = cell; }); }
    return rows.length ? rows : undefined;
  };
  return new Proxy({}, { get: (_, key) => (typeof key === "string" ? lookup(key) : undefined), has: (_, key) => typeof key === "string" && lookup(key) !== undefined });
}

/** Where each trigger the build made sits in the payload, and the line it came from. */
export interface TriggerMap {
  /** The payload's length in bytes: it ends where the strings section does. */
  payload: number;
  /**
   * Offset in the payload, conditions, actions, origin ("line:column", "file:line:column", or "" for a trigger no statement made) —
   * and, for a trigger of the emitter's that holds several statements' work, each action's origin.
   */
  triggers: [number, number, number, string, string[]?][];
}

/** The trigger map in a build's log (TRIGSCRIPT-MAP and its TRIGSCRIPT-ROWS); null when there is none or it is cut short. */
export function readTriggerMap(lines: Iterable<string>): TriggerMap | null {
  let head: { payload: number; count: number } | null = null;
  const triggers: TriggerMap["triggers"] = [];
  for (const line of lines) {
    if (line.startsWith("TRIGSCRIPT-MAP ")) head = JSON.parse(line.slice("TRIGSCRIPT-MAP ".length));
    else if (line.startsWith("TRIGSCRIPT-ROWS ")) triggers.push(...JSON.parse(line.slice("TRIGSCRIPT-ROWS ".length)));
  }
  return head && triggers.length === head.count ? { payload: head.payload, triggers } : null;
}
