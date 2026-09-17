/**
 * The intermediate representation: what a `program(() => { … })` body means, with
 * everything TypeScript-specific already settled — build-time values evaluated, records
 * split into their fields, functions inlined at their calls, `for…of` unrolled — and
 * nothing target-specific decided yet. `structured.ts` emits it from the TS AST;
 * `classic.ts` lowers it to death-counter triggers, `python/trigscript.py` to eudplib.
 * Plain data, JSON-serialisable (`eud.ts#serializeIr`); `docs/ir.md` is the reference.
 */
import type { ActionRecord, ConditionRecord } from "../vendor/triggers";

export const IR_VERSION = 1;

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

export type NumExpr =
  | { kind: "const"; value: number }
  | { kind: "var"; id: string }
  | { kind: "unary"; op: "-"; expr: NumExpr; at: At }
  | { kind: "binary"; op: "+" | "-" | "*" | "/" | "%"; left: NumExpr; right: NumExpr; at: At; label: string }
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
  | { kind: "sleep"; ms?: number; cycles?: number; at: At; label: string }
  /** A trigger action; `variable` names a field that takes an expression's value instead of the record's. */
  | { kind: "action"; record: ActionRecord; variable?: { field: keyof ActionRecord; bits: 8 | 32; name: string; expr: NumExpr }; at: At; label: string }
  | { kind: "call"; call: Call; at: At; label: string }
  /** A block only for scoping; nothing of its own. */
  | { kind: "block"; body: Stmt[]; at: At }
  /** A cost hint for the editor, tied to a line. */
  | { kind: "remark"; text: string; short?: string; at: At };

export interface Program {
  version: number;
  name?: string;
  owner: number;
  owners: number[];
  perPlayer: boolean;
  /** How many trigger cycles a second the classic target has (hyper triggers or not), for `sleep(seconds(n))`. */
  cyclesPerSecond: number;
  body: Stmt[];
  at: At;
}

export const isNumExpr = (e: NumExpr | BoolExpr): e is NumExpr => {
  switch (e.kind) {
    case "const": return typeof e.value === "number";
    case "var": return false; // ambiguous by shape; callers know the variable's kind
    case "unary": case "binary": case "intrinsic": return true;
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
