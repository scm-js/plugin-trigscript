/**
 * The intermediate representation: what a `program(() => { … })` body means, with
 * everything TypeScript-specific already settled — build-time values evaluated, records
 * split into their fields, functions inlined at their calls, `for…of` unrolled — and
 * nothing about eudplib decided yet. `structured.ts` emits it from the TS AST,
 * `python/trigscript.py` lowers it to eudplib, `simulateIr.ts` interprets it.
 * Plain data, JSON-serialisable (`eud.ts#serializeIr`); `docs/ir.md` is the reference.
 */
import type { ActionRecord, ConditionRecord } from "../vendor/triggers";
import type { InputSource } from "./input";

/**
 * 13: texts — a `text` variable (`VarDecl.text`: the id of a text of the built map's table, or a text that was made: where it is, the block of the heap it owns, its length in characters), `TextExpr`, `assignText`, `textLoop`, a text among a `print`'s parts, in an action's text field (`action.text`) and as a unit type's name; `textLength` / `textIndexOf` / `textCode` among the numbers, `textCompare` / `textTest` among the conditions; `ArrayDecl.texts`.
 * 12: arrays inside things — `ArrayDecl.slice` (a window on another array's cells) and `ArrayDecl.through` (a growing array whose handle is a cell of four others).
 * 11: recursion — `FuncDecl.recursive`, and `Call.saves` on a call that may come back into the function it is in: what that function keeps on the stack around the call.
 * 10: functions that are called — `Program.functions`, and `Call.fn` naming one: the call sets the function's parameters and runs its one body, where a call without `fn` carries a body of its own.
 * 9: a unit as the three numbers it is (`unitAt`, `unitPart`), which is what lets an array hold units.
 * 8: arrays that grow — `ArrayDecl.dynamic`, `push`, `pop`, `setLength`, `length` — out of a heap the programs share.
 * 7: arrays — `Program.arrays`, `declareArray`, `element` and `store` — of numbers and booleans, indexed by a constant or a variable; a list known when the script was built and indexed by a variable is an array too, one nothing writes (`values`).
 * 6: numbers are signed — `VarDecl.unsigned` marks a `u32`, `>>>` is an operator apart from `>>`, and `unsigned` on a division, a `min` / `max`, a printed number and a comparison says which reading the operation takes. The two-sided reading of `+` and `−` that made an unsigned cell mean a difference is gone.
 * 5: what the players do (`input`: keys, clicks, the mouse, typed lines), a pick near a player's mouse, `centerLocation`, and an action with several fields from the program (`variables`, where 4 had one `variable`).
 * 4: units on the map — `unit` variables, `unitLoop`, picks, unit fields, flags and verbs — and the cells of the game's tables (`tableRead` / `tableWrite`).
 * 3: reads (`read`), `random(n)` as a number, the bitwise operators and `print` with its text in parts.
 * 2: a record's text and sound are written out in the JSON (1 had the map's string indices); `cyclesPerSecond` is gone.
 */
export const IR_VERSION = 13;

/** Where a node came from; `column` is 1-based like `line`. */
export interface At { file: string; line: number; column: number }

/** A variable of the program. `id` is unique within the program; `name` is the source's. */
export interface VarDecl {
  id: string;
  name: string;
  /** `unit`: a unit on the map, or none — a pointer the lowering re-checks before each use, since the game reuses a dead unit's slot. */
  kind: "number" | "boolean" | "unit" | "text";
  /**
   * How a `text` variable is kept. `id`: it only ever receives texts known when the script is built, so it holds the
   * text's id in the built map's string table — one cell, assigning is copying a number, any action's text field takes
   * it. `made`: three cells — where the text is, the block of the heap it owns (0 when it owns none: a text of the
   * table), its length in characters. What holds a made text owns its block: assigning copies it (a value that was
   * just made is moved), and assigning or declaring again gives the old block back first.
   */
  text?: "id" | "made";
  /** `shared(…)`: one cell for every player of a per-player program. */
  shared: boolean;
  /** A `u8` / `u16` annotation; unset for the full 32 bits. */
  bits?: 8 | 16;
  /** A `u32`: the 32 bits read as 0 … 4 294 967 295. Unset, a number is signed (a `u8` / `u16` never goes below zero either way). */
  unsigned?: boolean;
  /** A backend's scratch value that dies with the statement (a function's result). */
  temp?: boolean;
  at: At;
}

/**
 * An array of the program: `length` cells of one kind, known when the script is built. A per-player
 * program has one for every player unless it is `shared`. `values`: a list the script computed when it
 * was built, which a program only reads — `const price = [50, 100, 150]; price[level]` — one for
 * everyone, never initialised in the game and never written. Reading past either end gives 0 (false);
 * a store past either end does nothing.
 */
export interface ArrayDecl {
  id: string;
  name: string;
  kind: "number" | "boolean";
  length: number;
  shared: boolean;
  bits?: 8 | 16;
  unsigned?: boolean;
  values?: number[];
  /** A list of texts the script has, which a program indexes with a variable (`titles[level]`): `values` are their places here, the lowering's their ids in the built map's table. */
  texts?: string[];
  /**
   * The array grows: something pushes to it, pops from it or sets its length. Its cells are a block of the
   * programs' heap (`HEAP_CELLS`), reached through a handle — where the block is, how many cells are in use, how
   * many it has room for — and `length` is only how many it starts with. A block that is full is exchanged for
   * one twice the size. Declared again (in a loop, in a function called again) it gives back the block it held.
   */
  dynamic?: boolean;
  /**
   * The array is a window on another's cells — a row of a grid (`grid[y]`, which is `length` cells of one flat array):
   * cell i of it is cell `offset + i` of `of`, where `offset` is a variable of the program set before the window is
   * used. It has no cells of its own and is never declared; past its own end it reads 0 and stores nothing, as any
   * array does, so a row never reaches into the next.
   */
  slice?: { of: string; offset: string };
  /**
   * The array is one that grows *inside* another — `buckets[i]` of `let buckets: number[][] = [[], []]`, the `path` of
   * `squads[i]`: its handle is not cells of its own but cell `index` (a variable of the program, set before this is
   * used) of four arrays the outer one keeps, a handle a row. What holds the handle owns the block: the front end gives
   * a row's block back (`declareArray` of this, empty) before the row goes — popped, cut off, the outer declared again.
   * A copy of the four cells is a second name for the same block, as a copy of a reference is, and no second owner.
   */
  through?: { ptr: string; len: string; room: string; k: string; index: string };
  at: At;
}

/**
 * The cells of the heap every program's growing arrays share, unless the map's script settings say otherwise
 * (`script.ts#ScriptSettings`, carried to the lowering as the IR file's `heap`); a block is a power of two of
 * them, four at least. Four bytes a cell in the built map, all zeros, so the saved file barely grows with it.
 */
export const HEAP_CELLS = 16384;
export const HEAP_CELLS_MIN = 1024;
export const HEAP_CELLS_MAX = 1 << 20;
/** A heap size as the build takes it: whole, within the limits; the default for anything that is not a number. */
export function heapCells(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.min(HEAP_CELLS_MAX, Math.max(HEAP_CELLS_MIN, Math.floor(value))) : HEAP_CELLS;
}
export const HEAP_SMALLEST = 4;

/**
 * How many calls deep a function that calls itself may go, unless the map's script settings say otherwise (carried to
 * the lowering as the IR file's `stack`). The stack is an array of its own in the built map — this many frames of the
 * largest frame any program has — and only there when some function recurses, so the limit is the same whatever the
 * programs' arrays hold: the simulator and the game stop at the same call.
 */
export const STACK_DEPTH = 1024;
export const STACK_DEPTH_MIN = 16;
export const STACK_DEPTH_MAX = 65536;
/** The most cells the stack may come to (depth × the largest frame): four bytes each while the map is played. */
export const STACK_CELLS_MAX = 1 << 20;
/** A depth as the build takes it: whole, within the limits; the default for anything that is not a number. */
export function stackDepth(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.min(STACK_DEPTH_MAX, Math.max(STACK_DEPTH_MIN, Math.floor(value))) : STACK_DEPTH;
}

/** A player's race as the game holds it; what `race(p)` gives and `supply()` takes. */
export type RaceId = 0 | 1 | 2;

/**
 * What a `read` reads. `condition`: the quantity a trigger condition tests — the record is
 * that condition with "at least 0" in it, so whatever the condition can be asked (a force's
 * minerals, the Marines a player brought to a location) can be read. `player`: a byte of
 * the game's player tables. `supply`: a player's supply as the top bar shows it, of one
 * race or (`race` null) of the race the player is. `player` is a slot, or 13 for the
 * current player.
 */
export type ReadSource =
  | { source: "condition"; record: ConditionRecord }
  | { source: "player"; fact: "race" | "slot" | "left"; player: number }
  | { source: "supply"; of: "used" | "max" | "provided"; race: RaceId | null; player: number };

/**
 * Which units a loop or a pick looks at, every part known when the script is built: a unit type
 * (230 Men, 231 Buildings, 232 Factories are the trigger classes), an owner (a slot, or 13 for the
 * current player) and a location the unit's centre is inside (1-based). An absent part matches all.
 */
export interface UnitFilter { type?: number; owner?: number; at?: number }

/** A number of a unit on the map. Hit points, shields and energy are whole points; the timers and the cooldown frames. */
export type UnitNumField = "hp" | "maxHp" | "shields" | "maxShields" | "energy" | "owner" | "type" | "x" | "y" | "kills" | "orderId" | "cooldown" | "resources"
  | "stim" | "ensnare" | "plague" | "lockdown" | "maelstrom" | "irradiate" | "stasis";
/** The ones a program may write; the rest the game keeps for itself (a position write ends the game). */
export const UNIT_WRITABLE: ReadonlySet<string> = new Set(["hp", "shields", "energy", "kills", "cooldown", "resources", "stim", "ensnare", "plague", "lockdown", "maelstrom", "irradiate", "stasis", "invincible"]);
export const UNIT_NUM_FIELDS: readonly UnitNumField[] = ["hp", "maxHp", "shields", "maxShields", "energy", "owner", "type", "x", "y", "kills", "orderId", "cooldown", "resources", "stim", "ensnare", "plague", "lockdown", "maelstrom", "irradiate", "stasis"];
/** A true / false of a unit on the map; only `invincible` takes a write. */
export type UnitFlag = "hallucinated" | "cloaked" | "burrowed" | "invincible" | "underAttack";
export const UNIT_FLAGS: readonly UnitFlag[] = ["hallucinated", "cloaked", "burrowed", "invincible", "underAttack"];

/** A unit on the map, or none. */
export type UnitExpr =
  | { kind: "unitNull" }
  | { kind: "unitVar"; id: string }
  /**
   * One unit among those the filter matches: the first in the game's unit table, the nearest to the
   * centre of location `near` (by |dx| + |dy|), or one at random. None when nothing matches.
   * `mouse` in place of `near`: nearest to that player's mouse (a slot, or 13 for the current
   * player), and no farther from it than `within` pixels.
   */
  | { kind: "pick"; by: "first" | "nearest" | "random"; filter: UnitFilter; near?: number; mouse?: number; within?: number; at: At; label: string }
  /**
   * The unit three numbers name — what `unitPart` gave of one, kept in cells of the program (an array of units is three
   * arrays of numbers). None when `ptr` is 0; like any kept unit it is re-checked before use.
   */
  | { kind: "unitAt"; ptr: NumExpr; epd: NumExpr; uid: NumExpr; at: At }
  /** A call inlined here whose result is a unit. */
  | { kind: "call"; call: Call };

/** What a unit is told to do. `to` and `target` are known when the script is built; an amount is the program's. */
export type UnitVerb =
  | { do: "kill" }
  | { do: "remove" }
  | { do: "give"; to: number }
  /** The game's own Order, reaching this unit alone. `target` is a location. */
  | { do: "order"; order: "move" | "patrol" | "attack"; target: number }
  /** Hit points down (at 0 the unit dies) or up (to the type's maximum), by points or by a percentage of the maximum. */
  | { do: "damage" | "heal"; amount: NumExpr; percent: boolean }
  /** Centre a location on the unit, its size kept. */
  | { do: "locate"; location: number };

/**
 * One cell of the game's tables (`tables.ts`): `base + index × stride + key`, `width` bytes or one
 * bit. `index` 13 in a player table is the current player. `scale`: stored = value × scale.
 */
export interface TableCell {
  /** "unit.minerals", "player.upgrades": the table and the field, for a log and the simulator. */
  name: string;
  base: number;
  stride: number;
  index: number;
  /** The second index of a keyed field (the upgrade of `stats(P1).upgrades[…]`), in bytes from the row's start. */
  key?: number;
  width: 1 | 2 | 4 | "bit";
  bit?: number;
  scale?: number;
  /** The index is a player: 13 means whoever the program is running as. */
  player?: boolean;
  special?: "speed" | "color" | "name";
}

/** `>>` keeps the sign of what it shifts; `>>>` fills with zeros. */
export type ArithOp = "+" | "-" | "*" | "/" | "%" | "&" | "|" | "^" | "<<" | ">>" | ">>>";

/** The largest and the smallest a `number` holds, and the largest a `u32` does. */
export const I32_MAX = 0x7fffffff;
export const I32_MIN = -0x80000000;
export const U32_MAX = 0xffffffff;

export type NumExpr =
  | { kind: "const"; value: number }
  | { kind: "var"; id: string }
  /** `hp[i]`: a cell of an array of numbers; 0 when the index is past either end. */
  | { kind: "element"; array: string; index: NumExpr; at: At }
  /**
   * One of the three numbers a unit is kept as: where it is in the game's unit table (`ptr`, 0 for none), the same as an
   * EPD, and the slot's uniqueness byte as it was when the unit was taken. Only ever stored and handed back to `unitAt`.
   */
  | { kind: "unitPart"; unit: UnitExpr; part: "ptr" | "epd" | "uid"; at: At }
  /** `xs.length`. Of an array that does not grow it is a constant, and `numbers.ts` makes it one. */
  | { kind: "length"; array: string; at: At }
  /** `xs.pop()`: the last cell, which the array then no longer has; 0 when it is empty. */
  | { kind: "pop"; array: string; at: At }
  | { kind: "unary"; op: "-"; expr: NumExpr; at: At }
  /** `u32(x)` / `i32(x)`: the same 32 bits read the other way. Nothing is computed; it is there for `numbers.ts`, which works out what each operation reads its sides as. */
  | { kind: "cast"; to: "u32" | "i32"; expr: NumExpr; at: At }
  /** `unsigned`, on `/` and `%`: both sides are `u32`s. Unset, the division is signed and rounds towards zero, the remainder taking the dividend's sign. */
  | { kind: "binary"; op: ArithOp; left: NumExpr; right: NumExpr; unsigned?: boolean; at: At; label: string }
  /** A value of the game, read when the expression is evaluated. */
  | { kind: "read"; read: ReadSource; at: At; label: string }
  /** `random(n)`: a whole number from 0 to n − 1, fresh at every evaluation; 0 when n is 0. */
  | { kind: "randomInt"; bound: NumExpr; at: At; label: string }
  /** A number of a unit on the map; 0 when the unit is none or gone. */
  | { kind: "unitField"; unit: UnitExpr; field: UnitNumField; at: At; label: string }
  /** A cell of the game's tables, unscaled: a flag reads 1 or 0. */
  | { kind: "tableRead"; cell: TableCell; at: At; label: string }
  /** What a player did, as it reached every computer (`input.ts`): a key or a click reads 1 on its frame, the mouse its place on the map, a typed line 1 or a value it carried. */
  | { kind: "input"; input: InputSource; at: At; label: string }
  | { kind: "ternary"; cond: BoolExpr; whenTrue: NumExpr; whenFalse: NumExpr; at: At; label: string }
  /** `unsigned`, on `min` and `max`: the arguments are compared as `u32`s. `abs` is of a signed number. */
  | { kind: "intrinsic"; name: "min" | "max" | "abs"; args: NumExpr[]; unsigned?: boolean; at: At; label: string }
  /** `s.length`, in characters (code points). */
  | { kind: "textLength"; of: TextExpr; at: At; label: string }
  /** `s.indexOf(find, from)`: the place of the first character of the first match at or after `from`, in characters; −1 when there is none. */
  | { kind: "textIndexOf"; of: TextExpr; find: TextExpr; from?: NumExpr; at: At; label: string }
  /** `s.codePointAt(i)`: the character's number; −1 past either end. */
  | { kind: "textCode"; of: TextExpr; index: NumExpr; at: At; label: string }
  /** A call inlined here: its body runs, its result is the number. */
  | { kind: "call"; call: Call };

/** The most bytes a text that was made holds (UTF-8, its end not counted): what is written past it is cut off, and said. */
export const TEXT_BYTES = 1023;
/** The most bytes of a made text an action's field or a unit type's name shows: the room of the table string it is written over. */
export const TEXT_FIELD_BYTES = 255;

/**
 * A text. `text` is one known when the script was built; a variable is one of the two ways `VarDecl.text` says; `textOf`
 * is a cell of a list of texts the script has. Those, and a `ternary` between them, are texts of the built map's table,
 * which have an id. Everything else is made while the map is played, into a block of the heap that the value owns
 * until something takes it (a variable, which keeps it) or has used it (a comparison, a `print`, which give it back).
 */
export type TextExpr =
  | { kind: "text"; text: string }
  | { kind: "textVar"; id: string }
  | { kind: "textOf"; array: string; index: NumExpr; at: At }
  /** A template, texts joined with `+`, `String(n)`: the parts one after another. */
  | { kind: "template"; parts: TextPart[]; at: At; label: string }
  | { kind: "textTernary"; cond: BoolExpr; whenTrue: TextExpr; whenFalse: TextExpr; at: At; label: string }
  /** The characters from `start` (0 when absent) up to `end` (the text's end when absent), both already inside 0 … length: `slice`, `substring`, `s[i]`, `at`, `charAt`. */
  | { kind: "textSlice"; of: TextExpr; start?: NumExpr; end?: NumExpr; at: At; label: string }
  /** `padStart` / `padEnd`: `with` over and over on that side until the text is `width` characters; unchanged when it is that long already or `with` is empty. */
  | { kind: "textPad"; of: TextExpr; side: "start" | "end"; width: NumExpr; with: TextExpr; at: At; label: string }
  /** `s.repeat(n)`; nothing when n is below 1. */
  | { kind: "textRepeat"; of: TextExpr; count: NumExpr; at: At; label: string }
  /** A call inlined here whose result is a text: the value is taken out of the call's result, which then holds none. */
  | { kind: "textCall"; call: Call };

const TEXT_KINDS: ReadonlySet<string> = new Set(["text", "textVar", "textOf", "template", "textTernary", "textSlice", "textPad", "textRepeat", "textCall"]);
export const isTextExpr = (e: { kind: string }): e is TextExpr => TEXT_KINDS.has(e.kind);

/** What a pass that walks or rewrites every expression does with the numbers, the conditions and the calls inside a text; the texts inside it are walked here. */
export interface TextMap { num: (e: NumExpr) => NumExpr; bool: (e: BoolExpr) => BoolExpr; call: (c: Call) => Call; /** For a pass that has something of its own to do with a text inside a text; absent, it is walked as the outer one is. */ text?: (t: TextExpr) => TextExpr }

const innerText = (t: TextExpr, f: TextMap): TextExpr => (f.text ? f.text(t) : mapText(t, f));

export function mapTextParts(parts: TextPart[], f: TextMap): TextPart[] {
  return parts.map((p) => (p.kind === "number" ? { ...p, expr: f.num(p.expr) } : p.kind === "value" ? { ...p, text: innerText(p.text, f) } : p));
}

/** A text with everything it is worked out from handed to `f` — a copy; a pass that only looks gives back what it was handed. */
export function mapText(t: TextExpr, f: TextMap): TextExpr {
  switch (t.kind) {
    case "textOf": return { ...t, index: f.num(t.index) };
    case "template": return { ...t, parts: mapTextParts(t.parts, f) };
    case "textTernary": return { ...t, cond: f.bool(t.cond), whenTrue: innerText(t.whenTrue, f), whenFalse: innerText(t.whenFalse, f) };
    case "textSlice": return { ...t, of: innerText(t.of, f), ...(t.start ? { start: f.num(t.start) } : {}), ...(t.end ? { end: f.num(t.end) } : {}) };
    case "textPad": return { ...t, of: innerText(t.of, f), width: f.num(t.width), with: innerText(t.with, f) };
    case "textRepeat": return { ...t, of: innerText(t.of, f), count: f.num(t.count) };
    case "textCall": return { ...t, call: f.call(t.call) };
    default: return t;
  }
}

/** The same for a number or a condition that is worked out from texts (`s.length`, `a == b`); undefined for any other. */
export function mapTextOperands<E extends NumExpr | BoolExpr>(e: E, f: TextMap): E | undefined {
  switch (e.kind) {
    case "textLength": return { ...e, of: innerText(e.of, f) };
    case "textIndexOf": return { ...e, of: innerText(e.of, f), find: innerText(e.find, f), ...(e.from ? { from: f.num(e.from) } : {}) };
    case "textCode": return { ...e, of: innerText(e.of, f), index: f.num(e.index) };
    case "textCompare": return { ...e, left: innerText(e.left, f), right: innerText(e.right, f) };
    case "textTest": return { ...e, of: innerText(e.of, f), find: innerText(e.find, f) };
    default: return undefined;
  }
}

/** Whether a text is one of the built map's table whatever happens when the map is played: it has an id. `kinds` says how each variable is kept. */
export function textHasId(e: TextExpr, kinds: (id: string) => "id" | "made" | undefined): boolean {
  switch (e.kind) {
    case "text": case "textOf": return true;
    case "textVar": return kinds(e.id) === "id";
    case "textTernary": return textHasId(e.whenTrue, kinds) && textHasId(e.whenFalse, kinds);
    default: return false;
  }
}

export type BoolExpr =
  | { kind: "const"; value: boolean }
  /** A trigger condition the script wrote, its fields known when the script is built. */
  | { kind: "cond"; record: ConditionRecord }
  /** A boolean variable. */
  | { kind: "var"; id: string }
  /** `alive[i]`: a cell of an array of booleans; false when the index is past either end. */
  | { kind: "element"; array: string; index: NumExpr; at: At }
  /** `flags.pop()` of an array of booleans; false when it is empty. */
  | { kind: "pop"; array: string; at: At }
  /** A number expression tested as a truth value: `!= 0`. */
  | { kind: "test"; expr: NumExpr; at: At; label: string }
  /**
   * `unsigned` true: both sides are read as `u32`s (or neither can be below zero, which comes to the same and costs less).
   * "left" / "right": that side is a `u32` and the other a signed number, compared exactly — a number below zero is smaller than any `u32`.
   */
  | { kind: "compare"; op: CompareOp; left: NumExpr; right: NumExpr; unsigned?: boolean | "left" | "right"; at: At; label: string }
  | { kind: "and"; items: BoolExpr[] }
  | { kind: "or"; items: BoolExpr[] }
  | { kind: "not"; expr: BoolExpr }
  /** `random()`: a coin toss, fresh at every evaluation. */
  | { kind: "random"; at: At }
  /** `if (target)`: the variable holds a unit and that unit is still on the map. */
  | { kind: "unitAlive"; unit: UnitExpr; at: At; label: string }
  /** `u == target`: both name the same unit of the game (and there is one). */
  | { kind: "unitSame"; left: UnitExpr; right: UnitExpr; at: At; label: string }
  /** A true / false of a unit; false when the unit is none or gone. */
  | { kind: "unitFlag"; unit: UnitExpr; flag: UnitFlag; at: At; label: string }
  /** `rose(c)` / `once(c)`: an edge on a condition, with a latch of its own. */
  | { kind: "edge"; edge: "rose" | "once"; cond: BoolExpr; at: At; label: string }
  | { kind: "ternary"; cond: BoolExpr; whenTrue: BoolExpr; whenFalse: BoolExpr; at: At; label: string }
  /** Two texts compared: the same characters, or the order of their characters' numbers (which is JavaScript's for every character the game draws). */
  | { kind: "textCompare"; op: CompareOp; left: TextExpr; right: TextExpr; at: At; label: string }
  /** `s.startsWith(find)`, `s.endsWith(find)`, `s.includes(find)`. */
  | { kind: "textTest"; test: "startsWith" | "endsWith" | "includes"; of: TextExpr; find: TextExpr; at: At; label: string }
  /** A call inlined here whose boolean result is tested. */
  | { kind: "call"; call: Call };

/** A piece of a `print`'s text: written text, a number's digits, a player's name, the colour code of a player's colour. */
export type TextPart =
  | { kind: "text"; text: string }
  /** `unsigned`: printed as a `u32`; unset, a number below zero has its minus sign. */
  | { kind: "number"; expr: NumExpr; unsigned?: boolean }
  | { kind: "name"; player: number }
  | { kind: "color"; player: number }
  /** A text of the program: a variable's, a function's result. */
  | { kind: "value"; text: TextExpr };

/** A field of an action filled in by the program: `bits` 8 is a unit count (done once per unit), 16 a unit type, 32 an amount. */
export interface ActionVariable { field: keyof ActionRecord; bits: 8 | 16 | 32; name: string; expr: NumExpr }

export type CompareOp = "<" | "<=" | ">" | ">=" | "==" | "!=";

/**
 * A function that is called: one body in the built map, which every `Call` naming it (`fn`) runs. Its parameters are
 * variables of its own that a call sets; `return` writes `result`, which the call copies into its own. It never sleeps.
 * `recursive`: it is on a cycle of the call graph — it calls itself, directly or round about (`recursion.ts`). Its
 * cells are still the program's own, one of each, so a call in its body that may come back into it keeps what the
 * function holds on the stack meanwhile (`Call.saves`), and such a call is always a statement of its own.
 */
export interface FuncDecl {
  id: string;
  name: string;
  params: VarDecl[];
  result?: { decl: VarDecl; kind: "number" | "boolean" | "unit" | "text" };
  recursive?: boolean;
  body: Stmt[];
  at: At;
}

/**
 * What a recursive function keeps on the stack around a call that may come back into it, and takes back after: the
 * variables (a cell each, three for a unit), the handles of the growing arrays declared in it (four cells each, set to
 * "no block" for the call — the block the inner run leaves is given back before the handle is taken back) and, not
 * listed, where the function returns to. `within` names the function the call is in, for the words of an overflow.
 */
export interface Saves { vars: string[]; arrays: string[]; within: string }

/**
 * A function at a call. Inlined (no `fn`): parameter copies, the body, and what it returns into. Called (`fn`): the
 * function is one of `Program.functions`; `params` are that function's own, each with this call's argument — all of
 * them worked out before any is set — `body` is empty, and `result` is this call's copy of what the function returned.
 */
export interface Call {
  name?: string;
  fn?: string;
  at: At;
  label: string;
  /** Parameters bound by copy (the function assigns them): a variable each, initialised from the argument. */
  params: { decl: VarDecl; init: NumExpr | BoolExpr | UnitExpr | TextExpr; label: string }[];
  /** What the call returns, when it returns something: the variable `return` writes. */
  result?: { decl: VarDecl; kind: "number" | "boolean" | "unit" | "text" };
  /** On a call inside a recursive function that may come back into it; such a call is a statement, never inside an expression. */
  saves?: Saves;
  body: Stmt[];
}

export type Stmt =
  /** `failed`: the initializer did not compile (reported already); the variable still exists, unset. */
  | { kind: "declare"; decl: VarDecl; init: NumExpr | BoolExpr | UnitExpr | TextExpr; failed?: boolean; at: At; label: string }
  /** `s = value`, `s += "!"`: the text the variable held is given back once the new one is worked out. */
  | { kind: "assignText"; target: string; value: TextExpr; at: At; label: string }
  /** `for (const ch of s)`: the body once a character, the text walked once — no `sleep` inside. `decl` is a made text of one character. */
  | { kind: "textLoop"; decl: VarDecl; of: TextExpr; body: Stmt[]; at: At; label: string }
  | { kind: "assign"; target: string; value: NumExpr; at: At; label: string }
  /** `let hp = [a, b, 0]` (`init`, a value a cell) or `new Array(12).fill(v)` (`fill`, one value for every cell): the array's cells are set, here and now. */
  | { kind: "declareArray"; array: string; init?: (NumExpr | BoolExpr)[]; fill?: NumExpr | BoolExpr; at: At; label: string }
  /** `hp[i] = value`; nothing happens when the index is past either end (the value is evaluated either way). */
  | { kind: "store"; array: string; index: NumExpr; value: NumExpr | BoolExpr; at: At; label: string }
  /** `xs.push(value)`: one more cell at the end. When the heap has no block left for it, nothing is pushed and the game says so once. */
  | { kind: "push"; array: string; value: NumExpr | BoolExpr; at: At; label: string }
  /** `xs.pop();` with its value unused. */
  | { kind: "pop"; array: string; at: At; label: string }
  /** `xs.length = n`: the array is cut to n cells; an n above its length changes nothing. */
  | { kind: "setLength"; array: string; value: NumExpr; at: At; label: string }
  | { kind: "assignBool"; target: string; value: BoolExpr; at: At; label: string }
  | { kind: "assignUnit"; target: string; value: UnitExpr; at: At; label: string }
  /**
   * `for (const u of unitsAt(…))`: the body once for every unit the filter matches, in the order of
   * the game's unit table, all within the frame — no `sleep` inside. `decl` is the unit of the turn.
   */
  | { kind: "unitLoop"; decl: VarDecl; filter: UnitFilter; body: Stmt[]; at: At; label: string }
  /** `u.hp = 40`, `u.invincible = true`: nothing happens when the unit is none or gone. */
  | { kind: "unitWrite"; unit: UnitExpr; field: UnitNumField | UnitFlag; value: NumExpr | BoolExpr; at: At; label: string }
  /** `u.kill()`, `u.order("move", there)`: nothing happens when the unit is none or gone. */
  | { kind: "unitDo"; unit: UnitExpr; verb: UnitVerb; at: At; label: string }
  /** `stats(units.TerranMarine).minerals = 25`. `scaled`: the value is already what the cell stores (a fraction known when the script was built); `boolean`: the value is a truth value, stored 1 or 0. */
  | { kind: "tableWrite"; cell: TableCell; value: NumExpr | BoolExpr | TextExpr; scaled?: boolean; boolean?: boolean; at: At; label: string }
  | { kind: "if"; cond: BoolExpr; then: Stmt[]; else?: Stmt[]; at: At; label: string }
  /** `cond` absent means `while (true)`. */
  | { kind: "while"; cond?: BoolExpr; body: Stmt[]; at: At; label: string }
  | { kind: "do"; body: Stmt[]; cond: BoolExpr; at: At; label: string; condLabel: string }
  /** `for` over a variable: `init` ran already (it is emitted before), this is the loop with its update. */
  | { kind: "for"; cond?: BoolExpr; update: Stmt[]; body: Stmt[]; at: At; label: string; /** The loop is `name.sort(…)`: for the hint on its line; a lowering takes no notice. */ sorts?: string }
  /** A loop unrolled when the script was built: the body once per value, in order. */
  | { kind: "unrolled"; iterations: Stmt[][]; at: At; label: string }
  | { kind: "switch"; value: NumExpr; cases: { value: number | null; body: Stmt[] }[]; at: At; label: string }
  | { kind: "break"; at: At; label: string }
  | { kind: "continue"; at: At; label: string }
  /** Inside an inlined call: leaves it, writing the result first when there is one. */
  | { kind: "return"; value?: NumExpr | BoolExpr | UnitExpr | TextExpr; at: At; label: string }
  /** `cycles` is a count of frames (`frames(n)`; `cycles(n)` is the older word for the same). */
  | { kind: "sleep"; ms?: number; cycles?: number; at: At; label: string }
  /** A trigger action; each of `variables` names a field that takes an expression's value instead of the record's. */
  /**
   * `text`: the action's text is the program's. One of the table goes into the action as its id. One that was made is
   * written over a string of the table the build keeps for this kind of field — the objectives, a leaderboard's label, a
   * transmission: a player has one of each at a time — and only on the computer of a player the action is for, since the
   * game reads the string again whenever it draws; past `TEXT_FIELD_BYTES` it is cut.
   */
  | { kind: "action"; record: ActionRecord; variables?: ActionVariable[]; text?: TextExpr; at: At; label: string }
  /** Centre a location on a point of the map, in pixels, its size kept. */
  | { kind: "centerLocation"; location: number; x: NumExpr; y: NumExpr; at: At; label: string }
  /**
   * Text with values in it, shown to `to` — a slot, 13 for the current player, All Players or a
   * force — in the chat area or on the line in the middle of the screen the game's own errors use.
   */
  | { kind: "print"; parts: TextPart[]; to: number; position: "chat" | "center"; at: At; label: string }
  | { kind: "call"; call: Call; at: At; label: string }
  /** A block only for scoping; nothing of its own. */
  | { kind: "block"; body: Stmt[]; at: At }
  /** A word for the editor about a line: a loop unrolled when the script was built. */
  | { kind: "remark"; text: string; short?: string; at: At };

export interface Program {
  version: number;
  name?: string;
  owner: number;
  owners: number[];
  perPlayer: boolean;
  /** Every array of the program, those of inlined functions included: what a backend allocates before anything runs. */
  arrays: ArrayDecl[];
  /** The functions that are called rather than inlined; absent when there is none. */
  functions?: FuncDecl[];
  body: Stmt[];
  at: At;
}

/** Every statement list of a program: its body, then the body of each function that is called. */
export function bodiesOf(program: Pick<Program, "body" | "functions">): Stmt[][] {
  return [program.body, ...(program.functions ?? []).map((f) => f.body)];
}

/** Every declaration of a program: its body's, and each called function's parameters, result and body. */
export function programDeclarations(program: Pick<Program, "body" | "functions">): VarDecl[] {
  const out = declarations(program.body);
  for (const f of program.functions ?? []) {
    out.push(...f.params);
    if (f.result) out.push(f.result.decl);
    out.push(...declarations(f.body));
  }
  return out;
}

/** Every call in a piece of IR — statements and expressions alike, those inside a call's arguments and body included. */
export function eachCall(root: unknown, visit: (c: Call) => void): void {
  if (Array.isArray(root)) { for (const x of root) eachCall(x, visit); return; }
  if (!root || typeof root !== "object") return;
  const o = root as Record<string, unknown>;
  if (o.kind === "call" && o.call && typeof o.call === "object") visit(o.call as Call);
  for (const v of Object.values(o)) if (v && typeof v === "object") eachCall(v, visit);
}

export const isUnitExpr = (e: NumExpr | BoolExpr | UnitExpr | TextExpr): e is UnitExpr =>
  e.kind === "unitNull" || e.kind === "unitVar" || e.kind === "pick" || e.kind === "unitAt" || (e.kind === "call" && e.call.result?.kind === "unit");

export const isNumExpr = (e: NumExpr | BoolExpr | UnitExpr | TextExpr): e is NumExpr => {
  switch (e.kind) {
    case "textLength": case "textIndexOf": case "textCode": return true;
    case "const": return typeof e.value === "number";
    case "var": return false; // ambiguous by shape; callers know the variable's kind
    case "element": case "pop": return false; // ambiguous by shape, as a variable is
    case "length": case "unitPart": return true;
    case "unary": case "cast": case "binary": case "intrinsic": case "read": case "randomInt": case "unitField": case "tableRead": case "input": return true;
    case "ternary": return isNumExpr(e.whenTrue);
    case "call": return e.call.result?.kind === "number";
    default: return false;
  }
};

/** Every declaration in a body, in order, calls included. */
export function declarations(body: Stmt[]): VarDecl[] {
  const out: VarDecl[] = [];
  const stmt = (s: Stmt) => {
    switch (s.kind) {
      case "declare": out.push(s.decl); init(s.init); break;
      case "assign": expr(s.value); break;
      case "declareArray": s.init?.forEach(init); if (s.fill) init(s.fill); break;
      case "store": expr(s.index); init(s.value); break;
      case "push": init(s.value); break;
      case "setLength": expr(s.value); break;
      case "assignBool": init(s.value); break;
      case "assignUnit": unit(s.value); break;
      case "assignText": text(s.value); break;
      case "textLoop": text(s.of); out.push(s.decl); s.body.forEach(stmt); break;
      case "unitLoop": out.push(s.decl); s.body.forEach(stmt); break;
      case "unitWrite": unit(s.unit); init(s.value); break;
      case "unitDo": unit(s.unit); if (s.verb.do === "damage" || s.verb.do === "heal") expr(s.verb.amount); break;
      case "tableWrite": init(s.value); break;
      case "if": init(s.cond); s.then.forEach(stmt); s.else?.forEach(stmt); break;
      case "while": if (s.cond) init(s.cond); s.body.forEach(stmt); break;
      case "do": s.body.forEach(stmt); init(s.cond); break;
      case "for": if (s.cond) init(s.cond); s.update.forEach(stmt); s.body.forEach(stmt); break;
      case "unrolled": s.iterations.forEach((i) => i.forEach(stmt)); break;
      case "switch": expr(s.value); s.cases.forEach((c) => c.body.forEach(stmt)); break;
      case "return": if (s.value) init(s.value); break;
      case "action": for (const v of s.variables ?? []) expr(v.expr); if (s.text) text(s.text); break;
      case "centerLocation": expr(s.x); expr(s.y); break;
      case "print": parts(s.parts); break;
      case "call": call(s.call); break;
      case "block": s.body.forEach(stmt); break;
      default: break;
    }
  };
  const call = (c: Call) => {
    if (c.result) out.push(c.result.decl);
    // A called function's parameters are the function's own: `programDeclarations` lists them once.
    for (const p of c.params) { if (!c.fn) out.push(p.decl); init(p.init); }
    c.body.forEach(stmt);
  };
  const init = (e: NumExpr | BoolExpr | UnitExpr | TextExpr) => (isTextExpr(e) ? text(e) : isUnitExpr(e) ? unit(e) : isNumExpr(e) ? expr(e) : bool(e));
  const parts = (ps: TextPart[]) => { for (const p of ps) { if (p.kind === "number") expr(p.expr); else if (p.kind === "value") text(p.text); } };
  const text = (t: TextExpr) => {
    switch (t.kind) {
      case "textOf": expr(t.index); break;
      case "template": parts(t.parts); break;
      case "textTernary": bool(t.cond); text(t.whenTrue); text(t.whenFalse); break;
      case "textSlice": text(t.of); if (t.start) expr(t.start); if (t.end) expr(t.end); break;
      case "textPad": text(t.of); expr(t.width); text(t.with); break;
      case "textRepeat": text(t.of); expr(t.count); break;
      case "textCall": call(t.call); break;
      default: break;
    }
  };
  const unit = (u: UnitExpr) => { if (u.kind === "call") call(u.call); else if (u.kind === "unitAt") { expr(u.ptr); expr(u.epd); expr(u.uid); } };
  const expr = (e: NumExpr) => {
    switch (e.kind) {
      case "unitField": case "unitPart": unit(e.unit); break;
      case "element": expr(e.index); break;
      case "unary": case "cast": expr(e.expr); break;
      case "binary": expr(e.left); expr(e.right); break;
      case "ternary": bool(e.cond); expr(e.whenTrue); expr(e.whenFalse); break;
      case "intrinsic": e.args.forEach(expr); break;
      case "randomInt": expr(e.bound); break;
      case "textLength": text(e.of); break;
      case "textIndexOf": text(e.of); text(e.find); if (e.from) expr(e.from); break;
      case "textCode": text(e.of); expr(e.index); break;
      case "call": call(e.call); break;
      default: break;
    }
  };
  const bool = (b: BoolExpr) => {
    switch (b.kind) {
      case "unitAlive": case "unitFlag": unit(b.unit); break;
      case "unitSame": unit(b.left); unit(b.right); break;
      case "element": expr(b.index); break;
      case "test": expr(b.expr); break;
      case "compare": expr(b.left); expr(b.right); break;
      case "and": case "or": b.items.forEach(bool); break;
      case "not": bool(b.expr); break;
      case "edge": bool(b.cond); break;
      case "ternary": bool(b.cond); bool(b.whenTrue); bool(b.whenFalse); break;
      case "textCompare": text(b.left); text(b.right); break;
      case "textTest": text(b.of); text(b.find); break;
      case "call": call(b.call); break;
      default: break;
    }
  };
  body.forEach(stmt);
  return out;
}
