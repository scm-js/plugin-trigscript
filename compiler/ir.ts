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
 * 5: what the players do (`input`: keys, clicks, the mouse, typed lines), a pick near a player's mouse, `centerLocation`, and an action with several fields from the program (`variables`, where 4 had one `variable`).
 * 4: units on the map — `unit` variables, `unitLoop`, picks, unit fields, flags and verbs — and the cells of the game's tables (`tableRead` / `tableWrite`).
 * 3: reads (`read`), `random(n)` as a number, the bitwise operators and `print` with its text in parts.
 * 2: a record's text and sound are written out in the JSON (1 had the map's string indices); `cyclesPerSecond` is gone.
 */
export const IR_VERSION = 5;

/** Where a node came from; `column` is 1-based like `line`. */
export interface At { file: string; line: number; column: number }

/** A variable of the program. `id` is unique within the program; `name` is the source's. */
export interface VarDecl {
  id: string;
  name: string;
  /** `unit`: a unit on the map, or none — a pointer the lowering re-checks before each use, since the game reuses a dead unit's slot. */
  kind: "number" | "boolean" | "unit";
  /** `shared(…)`: one cell for every player of a per-player program. */
  shared: boolean;
  /** A `u8` / `u16` annotation; unset for the full 32 bits. */
  bits?: 8 | 16;
  /** A backend's scratch value that dies with the statement (a function's result). */
  temp?: boolean;
  at: At;
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

export type ArithOp = "+" | "-" | "*" | "/" | "%" | "&" | "|" | "^" | "<<" | ">>";

export type NumExpr =
  | { kind: "const"; value: number }
  | { kind: "var"; id: string }
  | { kind: "unary"; op: "-"; expr: NumExpr; at: At }
  | { kind: "binary"; op: ArithOp; left: NumExpr; right: NumExpr; at: At; label: string }
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
  | { kind: "intrinsic"; name: "min" | "max" | "abs"; args: NumExpr[]; at: At; label: string }
  /** A call inlined here: its body runs, its result is the number. */
  | { kind: "call"; call: Call };

export type BoolExpr =
  | { kind: "const"; value: boolean }
  /** A trigger condition the script wrote, its fields known when the script is built. */
  | { kind: "cond"; record: ConditionRecord }
  /** A boolean variable. */
  | { kind: "var"; id: string }
  /** A number expression tested as a truth value: `!= 0`. */
  | { kind: "test"; expr: NumExpr; at: At; label: string }
  | { kind: "compare"; op: CompareOp; left: NumExpr; right: NumExpr; at: At; label: string }
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
  /** A call inlined here whose boolean result is tested. */
  | { kind: "call"; call: Call };

/** A piece of a `print`'s text: written text, a number's digits, a player's name, the colour code of a player's colour. */
export type TextPart =
  | { kind: "text"; text: string }
  | { kind: "number"; expr: NumExpr }
  | { kind: "name"; player: number }
  | { kind: "color"; player: number };

/** A field of an action filled in by the program: `bits` 8 is a unit count (done once per unit), 16 a unit type, 32 an amount. */
export interface ActionVariable { field: keyof ActionRecord; bits: 8 | 16 | 32; name: string; expr: NumExpr }

export type CompareOp = "<" | "<=" | ">" | ">=" | "==" | "!=";

/** A function inlined at a call: parameter copies, the body, and what it returns into. */
export interface Call {
  name?: string;
  at: At;
  label: string;
  /** Parameters bound by copy (the function assigns them): a variable each, initialised from the argument. */
  params: { decl: VarDecl; init: NumExpr | BoolExpr | UnitExpr; label: string }[];
  /** What the call returns, when it returns something: the variable `return` writes. */
  result?: { decl: VarDecl; kind: "number" | "boolean" | "unit" };
  body: Stmt[];
}

export type Stmt =
  /** `failed`: the initializer did not compile (reported already); the variable still exists, unset. */
  | { kind: "declare"; decl: VarDecl; init: NumExpr | BoolExpr | UnitExpr; failed?: boolean; at: At; label: string }
  | { kind: "assign"; target: string; value: NumExpr; at: At; label: string }
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
  | { kind: "tableWrite"; cell: TableCell; value: NumExpr | BoolExpr | { kind: "text"; text: string }; scaled?: boolean; boolean?: boolean; at: At; label: string }
  | { kind: "if"; cond: BoolExpr; then: Stmt[]; else?: Stmt[]; at: At; label: string }
  /** `cond` absent means `while (true)`. */
  | { kind: "while"; cond?: BoolExpr; body: Stmt[]; at: At; label: string }
  | { kind: "do"; body: Stmt[]; cond: BoolExpr; at: At; label: string; condLabel: string }
  /** `for` over a variable: `init` ran already (it is emitted before), this is the loop with its update. */
  | { kind: "for"; cond?: BoolExpr; update: Stmt[]; body: Stmt[]; at: At; label: string }
  /** A loop unrolled when the script was built: the body once per value, in order. */
  | { kind: "unrolled"; iterations: Stmt[][]; at: At; label: string }
  | { kind: "switch"; value: NumExpr; cases: { value: number | null; body: Stmt[] }[]; at: At; label: string }
  | { kind: "break"; at: At; label: string }
  | { kind: "continue"; at: At; label: string }
  /** Inside an inlined call: leaves it, writing the result first when there is one. */
  | { kind: "return"; value?: NumExpr | BoolExpr | UnitExpr; at: At; label: string }
  /** `cycles` is a count of frames (`frames(n)`; `cycles(n)` is the older word for the same). */
  | { kind: "sleep"; ms?: number; cycles?: number; at: At; label: string }
  /** A trigger action; each of `variables` names a field that takes an expression's value instead of the record's. */
  | { kind: "action"; record: ActionRecord; variables?: ActionVariable[]; at: At; label: string }
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
  body: Stmt[];
  at: At;
}

export const isUnitExpr = (e: NumExpr | BoolExpr | UnitExpr | { kind: "text" }): e is UnitExpr =>
  e.kind === "unitNull" || e.kind === "unitVar" || e.kind === "pick" || (e.kind === "call" && e.call.result?.kind === "unit");

export const isNumExpr = (e: NumExpr | BoolExpr | UnitExpr): e is NumExpr => {
  switch (e.kind) {
    case "const": return typeof e.value === "number";
    case "var": return false; // ambiguous by shape; callers know the variable's kind
    case "unary": case "binary": case "intrinsic": case "read": case "randomInt": case "unitField": case "tableRead": case "input": return true;
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
      case "assignBool": init(s.value); break;
      case "assignUnit": unit(s.value); break;
      case "unitLoop": out.push(s.decl); s.body.forEach(stmt); break;
      case "unitWrite": unit(s.unit); init(s.value); break;
      case "unitDo": unit(s.unit); if (s.verb.do === "damage" || s.verb.do === "heal") expr(s.verb.amount); break;
      case "tableWrite": if (s.value.kind !== "text") init(s.value); break;
      case "if": init(s.cond); s.then.forEach(stmt); s.else?.forEach(stmt); break;
      case "while": if (s.cond) init(s.cond); s.body.forEach(stmt); break;
      case "do": s.body.forEach(stmt); init(s.cond); break;
      case "for": if (s.cond) init(s.cond); s.update.forEach(stmt); s.body.forEach(stmt); break;
      case "unrolled": s.iterations.forEach((i) => i.forEach(stmt)); break;
      case "switch": expr(s.value); s.cases.forEach((c) => c.body.forEach(stmt)); break;
      case "return": if (s.value) init(s.value); break;
      case "action": for (const v of s.variables ?? []) expr(v.expr); break;
      case "centerLocation": expr(s.x); expr(s.y); break;
      case "print": for (const p of s.parts) if (p.kind === "number") expr(p.expr); break;
      case "call": call(s.call); break;
      case "block": s.body.forEach(stmt); break;
      default: break;
    }
  };
  const call = (c: Call) => {
    if (c.result) out.push(c.result.decl);
    for (const p of c.params) { out.push(p.decl); init(p.init); }
    c.body.forEach(stmt);
  };
  const init = (e: NumExpr | BoolExpr | UnitExpr) => (isUnitExpr(e) ? unit(e) : isNumExpr(e) ? expr(e) : bool(e));
  const unit = (u: UnitExpr) => { if (u.kind === "call") call(u.call); };
  const expr = (e: NumExpr) => {
    switch (e.kind) {
      case "unitField": unit(e.unit); break;
      case "unary": expr(e.expr); break;
      case "binary": expr(e.left); expr(e.right); break;
      case "ternary": bool(e.cond); expr(e.whenTrue); expr(e.whenFalse); break;
      case "intrinsic": e.args.forEach(expr); break;
      case "randomInt": expr(e.bound); break;
      case "call": call(e.call); break;
      default: break;
    }
  };
  const bool = (b: BoolExpr) => {
    switch (b.kind) {
      case "unitAlive": case "unitFlag": unit(b.unit); break;
      case "unitSame": unit(b.left); unit(b.right); break;
      case "test": expr(b.expr); break;
      case "compare": expr(b.left); expr(b.right); break;
      case "and": case "or": b.items.forEach(bool); break;
      case "not": bool(b.expr); break;
      case "edge": bool(b.cond); break;
      case "ternary": bool(b.cond); bool(b.whenTrue); bool(b.whenFalse); break;
      case "call": call(b.call); break;
      default: break;
    }
  };
  body.forEach(stmt);
  return out;
}
