/**
 * The intermediate representation: what a `program(() => { … })` body means, with
 * everything TypeScript-specific already settled — build-time values evaluated, records
 * split into their fields, functions inlined at their calls, `for…of` unrolled — and
 * nothing about eudplib decided yet. `structured.ts` emits it from the TS AST,
 * `python/trigscript.py` lowers it to eudplib, `simulateIr.ts` interprets it.
 * Plain data, JSON-serialisable (`eud.ts#serializeIr`); `docs/ir.md` is the reference.
 */
import type { ActionRecord, ConditionRecord } from "../vendor/triggers";

/**
 * 3: reads (`read`), `random(n)` as a number, the bitwise operators and `print` with its text in parts.
 * 2: a record's text and sound are written out in the JSON (1 had the map's string indices); `cyclesPerSecond` is gone.
 */
export const IR_VERSION = 3;

/** Where a node came from; `column` is 1-based like `line`. */
export interface At { file: string; line: number; column: number }

/** A variable of the program. `id` is unique within the program; `name` is the source's. */
export interface VarDecl {
  id: string;
  name: string;
  kind: "number" | "boolean";
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

export type CompareOp = "<" | "<=" | ">" | ">=" | "==" | "!=";

/** A function inlined at a call: parameter copies, the body, and what it returns into. */
export interface Call {
  name?: string;
  at: At;
  label: string;
  /** Parameters bound by copy (the function assigns them): a variable each, initialised from the argument. */
  params: { decl: VarDecl; init: NumExpr | BoolExpr; label: string }[];
  /** What the call returns, when it returns something: the variable `return` writes. */
  result?: { decl: VarDecl; kind: "number" | "boolean" };
  body: Stmt[];
}

export type Stmt =
  /** `failed`: the initializer did not compile (reported already); the variable still exists, unset. */
  | { kind: "declare"; decl: VarDecl; init: NumExpr | BoolExpr; failed?: boolean; at: At; label: string }
  | { kind: "assign"; target: string; value: NumExpr; at: At; label: string }
  | { kind: "assignBool"; target: string; value: BoolExpr; at: At; label: string }
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
  | { kind: "return"; value?: NumExpr | BoolExpr; at: At; label: string }
  /** `cycles` is a count of frames (`frames(n)`; `cycles(n)` is the older word for the same). */
  | { kind: "sleep"; ms?: number; cycles?: number; at: At; label: string }
  /** A trigger action; `variable` names a field that takes an expression's value instead of the record's. */
  | { kind: "action"; record: ActionRecord; variable?: { field: keyof ActionRecord; bits: 8 | 32; name: string; expr: NumExpr }; at: At; label: string }
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

export const isNumExpr = (e: NumExpr | BoolExpr): e is NumExpr => {
  switch (e.kind) {
    case "const": return typeof e.value === "number";
    case "var": return false; // ambiguous by shape; callers know the variable's kind
    case "unary": case "binary": case "intrinsic": case "read": case "randomInt": return true;
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
      case "if": init(s.cond); s.then.forEach(stmt); s.else?.forEach(stmt); break;
      case "while": if (s.cond) init(s.cond); s.body.forEach(stmt); break;
      case "do": s.body.forEach(stmt); init(s.cond); break;
      case "for": if (s.cond) init(s.cond); s.update.forEach(stmt); s.body.forEach(stmt); break;
      case "unrolled": s.iterations.forEach((i) => i.forEach(stmt)); break;
      case "switch": expr(s.value); s.cases.forEach((c) => c.body.forEach(stmt)); break;
      case "return": if (s.value) init(s.value); break;
      case "action": if (s.variable) expr(s.variable.expr); break;
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
  const init = (e: NumExpr | BoolExpr) => (isNumExpr(e) ? expr(e) : bool(e));
  const expr = (e: NumExpr) => {
    switch (e.kind) {
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
