/**
 * The emitter (TrigScript 4, the backend: E1 and the start of E2). It takes the loops of a program whose every
 * statement it can lower — numbers added, taken away, set and compared, `if`, `while`, `do`, `for`, `break`, `continue`
 * — and lowers each to a graph of triggers (`graph.ts`), replacing the loop in the IR with a `graph` statement that keeps
 * the loop as its `original` (what the simulator runs). Everything else stays the Python side's.
 *
 * Values are written where they are used. A number has *places*: its variable's cell, the dwords that hold it plus a
 * constant for conditions to read as memory (a comparison reads its left side so, the constant making a signed order
 * an unsigned one), and every number field of a trigger that reads it — a condition's number, an action's number. A
 * write writes every place: `i += 1` with i read in four places is five actions in one trigger, where eudplib adds to
 * i's cell and then routes the cell to each reader. `x = y + z` sets each of x's places from y and adds z to each, so
 * y's places include the numbers of those actions, which y's own writes keep. A write is laid out after every write
 * that reads its variable is (they make its places); a variable in a loop of such reads — `x = y` and `y = x` — or set
 * from itself other than by adding is written into its cell alone and copied into the rest after. A place may hold any
 * constant times the variable, so a product by a constant and a shift by one cost nothing more than a sum.
 *
 * The layout is the emitter's own: a loop tests whether to leave, which fails on every turn but the last, so a turn
 * falls through one trigger whose conditions failed (13.4 ns); a branch is a trigger that sets its own next pointer to
 * where it goes, put back by an action at the place it went to.
 */
import { STACK_DEPTH, type ArrayDecl, type BoolExpr, type Call, type FuncDecl, type NumExpr, type Program, type Stmt, type TextPart, type VarDecl, type At } from "../ir";
import { PACK_FROM } from "../eud";
import type { Range } from "../ranges";
import { PlayerGroup } from "../../vendor/triggers";
import { actionDef, conditionDef } from "../../vendor/triggerDefs";
import { END, MOST_ACTS, MOST_CONDS, STACK, TRIGGER_BYTES, checkGraph, nextOf, type Act, type Compare, type Cond, type Dword, type FixedFn, type Graph, type Num, type Region, type Trigger } from "./graph";

/** The game's tick (frames since the game started), and the fields of the trigger a map of our own wakes by. */
export const GAME_TICK = 0x57f23c;
export const WAKE_TICK = "@wake.tick", WAKE_AT = "@wake.at", WAKE_NEXT = "@wake.next";
const FRAMES_PER_SECOND = 24;
const U32 = 2 ** 32;
const SIGN = 2 ** 31;
const MAX = U32 - 1;
const u = (n: number) => ((n % U32) + U32) % U32;

/** a × b, wrapping at 32 bits, both read from 0 up. */
const mul = (a: number, b: number) => u(Math.imul(a, b));

/** a / b or a % b as the simulator has them: towards zero, the remainder with a's sign, or (`unsigned`) read from 0 up; by 0, 0. */
function quotient(op: "/" | "%", a: number, b: number, unsigned: boolean): number {
  if (u(b) === 0) return 0;
  const [x, y] = unsigned ? [u(a), u(b)] : [a | 0, b | 0];
  return op === "/" ? Math.trunc(x / y) : x % y;
}

/** A number as the emitter has it: a constant plus variables, each times a constant (read from 0 up, wrapping). */
interface Linear { c: number; terms: { id: string; k: number }[] }

function scaled(l: Linear, by: number): Linear {
  return { c: mul(l.c, by), terms: l.terms.map((t) => ({ id: t.id, k: mul(t.k, by) })) };
}

/** The same terms of one variable added together; none times 0. */
function merged(c: number, terms: { id: string; k: number }[]): Linear {
  const by = new Map<string, number>();
  for (const t of terms) by.set(t.id, u((by.get(t.id) ?? 0) + t.k));
  return { c: u(c), terms: [...by].filter(([, k]) => k !== 0).map(([id, k]) => ({ id, k })) };
}

function linear(e: NumExpr, cell?: (e: Extract<NumExpr, { kind: "element" | "binary" }>, sides?: [Linear, Linear]) => string | null): Linear | null {
  switch (e.kind) {
    case "const": return e.fn ? null : { c: u(e.value), terms: [] };
    case "var": return { c: 0, terms: [{ id: e.id, k: 1 }] };
    // (A cell the caller reads into a variable of its own first, when it can.)
    case "element": {
      const id = cell?.(e);
      return id ? { c: 0, terms: [{ id, k: 1 }] } : null;
    }
    case "cast": return e.to === "fixed" ? null : linear(e.expr, cell);
    case "unary": {
      const l = linear(e.expr, cell);
      return l && scaled(l, MAX);
    }
    case "binary": {
      // (A shift right by a constant: the caller reads it into a variable of its own first, when it can.)
      if ((e.op === ">>" || e.op === ">>>") && cell) {
        const id = cell(e);
        if (id) return { c: 0, terms: [{ id, k: 1 }] };
      }
      const a = linear(e.left, cell), b = linear(e.right, cell);
      if (!a || !b) return null;
      if (e.op === "+") return merged(a.c + b.c, [...a.terms, ...b.terms]);
      if (e.op === "-") return merged(a.c - b.c, [...a.terms, ...scaled(b, MAX).terms]);
      // A product with a constant, a shift left by one: the same 32 bits as the multiplication.
      if (e.op === "*" && b.terms.length === 0) return merged(mul(a.c, b.c), scaled(a, b.c).terms);
      if (e.op === "*" && a.terms.length === 0) return merged(mul(a.c, b.c), scaled(b, a.c).terms);
      if (e.op === "<<" && b.terms.length === 0) {
        const by = u(2 ** (b.c & 31));
        return merged(mul(a.c, by), scaled(a, by).terms);
      }
      if ((e.op === "/" || e.op === "%") && a.terms.length === 0 && b.terms.length === 0) return { c: u(quotient(e.op, a.c, b.c, !!e.unsigned)), terms: [] };
      // (A product of two values, a quotient, a remainder: the caller works it out into a variable of its own first,
      // when it can — its sides already read, so that what they read comes first.)
      if (cell && (e.op === "*" || e.op === "/" || e.op === "%")) {
        const id = cell(e, [a, b]);
        if (id) return { c: 0, terms: [{ id, k: 1 }] };
      }
      return null;
    }
    default: return null;
  }
}

/**
 * One variable plus a constant, or a constant: what a comparison's side can be — or a variable's bits under a constant
 * mask (`x & K`), which a condition reads as they are, against a constant.
 */
type Side = { id: string; c: number; mask?: number } | { k: number };
function side(e: NumExpr): Side | null {
  if (e.kind === "binary" && e.op === "&") {
    const [v, k] = e.right.kind === "const" ? [e.left, e.right] : e.left.kind === "const" ? [e.right, e.left] : [null, null];
    const l = v && linear(v);
    if (l && k && k.kind === "const" && l.c === 0 && l.terms.length === 1 && l.terms[0].k === 1) return { id: l.terms[0].id, c: 0, mask: u(k.value) };
    return null;
  }
  const l = linear(e);
  if (!l) return null;
  if (l.terms.length === 0) return { k: l.c };
  if (l.terms.length === 1 && l.terms[0].k === 1) return { id: l.terms[0].id, c: l.c };
  return null;
}

// ── what a map of our own refuses, said ──

/** Why an array is not one a map of our own keeps (`nativeArray`), in a script's words. */
function arrayWhy(a: ArrayDecl): string | undefined {
  if (a.texts) return "an array of texts";
  if (a.dynamic || a.through) return "an array that grows";
  if (a.task !== undefined) return "an array of a task's";
  if (a.bits) return `a u${a.bits} array`;
  if (a.kind !== "number" && a.kind !== "boolean") return `an array of ${a.kind}s`;
  return undefined;
}

/**
 * The first thing in a statement a map of our own refused that its emitter never takes, in a script's words: the
 * reason a refusal gives when the checks that refused it gave none ("a product of two values", "the action Create
 * Unit"). Inner parts before the whole, in the order they are written; undefined when every part is one the emitter
 * takes somewhere, and the reason lies in how they are put together.
 */
export function unlowered(s: Stmt, decls: Map<string, VarDecl>, arrays: Map<string, ArrayDecl>): string | undefined {
  const variable = (id: string): string | undefined => {
    const d = decls.get(id);
    if (!d) return undefined;
    if (d.kind === "unit") return "a unit kept in a variable";
    // (A program with `try` or `throw` keeps the message of the error in flight: what it is refused for is the error.)
    if (d.kind === "text") return d.name === "(error message)" ? "an error thrown or caught (try, throw)" : d.name.startsWith("(") ? "a text made while the game runs" : "a text kept in a variable";
    if (d.bits) return `a u${d.bits} variable`;
    if (d.task !== undefined) return "a variable of a task's";
    if (d.held) return "a variable a closure keeps";
    return undefined;
  };
  const array = (id: string): string | undefined => {
    const a = arrays.get(id);
    return a && arrayWhy(a);
  };
  const plainSide = (e: NumExpr): boolean => linear(e) !== null || e.kind === "element";
  const isConst = (e: NumExpr): boolean => linear(e)?.terms.length === 0;
  const binary = (e: Extract<NumExpr, { kind: "binary" }>): string | undefined => {
    if (linear(e) || !plainSide(e.left) || !plainSide(e.right)) return undefined;
    const byConst = isConst(e.right);
    switch (e.op) {
      case "&": case "|": case "^": return byConst ? `${e.op} with a constant, as a value` : `${e.op} of two values`;
      case "<<": case ">>": case ">>>": return byConst ? `a shift by a constant (${e.op}) as a value` : `a shift by a value (${e.op})`;
      default: return undefined;
    }
  };
  const boolOnly = new Set(["compare", "and", "or", "not", "test", "cond", "random", "running", "unitAlive", "unitSame", "unitFlag", "edge", "textCompare", "textTest"]);
  // Expressions: what each kind is, when the emitter never takes it.
  const node = (o: Record<string, unknown>): string | undefined => {
    switch (o.kind) {
      case "binary": return binary(o as Extract<NumExpr, { kind: "binary" }>);
      case "intrinsic": {
        const name = o.name as string;
        if (name === "fmul") return "a product of fixed numbers";
        if (name === "fdiv") return "a quotient of fixed numbers";
        return name === "min" || name === "max" || name === "abs" ? undefined : `Math.${name}`;
      }
      case "read": {
        const r = o.read as { source: string; record?: { type: number }; fact?: string; of?: string };
        if (r.source === "condition") return `a read of the game (${conditionDef(r.record!.type)?.name ?? `condition ${r.record!.type}`})`;
        if (r.source === "player") return r.fact === "left" ? "whether a player has left" : `a player's ${r.fact}`;
        return `a player's supply (${r.of})`;
      }
      case "cond": {
        const r = o.record as { type: number; player: number };
        if (r.type === DEATHS_CONDITION && r.player > LAST_GROUP) return "a read of memory (memory())";
        return `the condition ${conditionDef(r.type)?.name ?? r.type}`;
      }
      case "tableRead": return `a read of ${(o.cell as { name: string }).name}`;
      case "randomInt": return "a random number";
      case "random": return "a random boolean";
      case "input": return `the players' input (${(o.input as { source: string }).source})`;
      case "length": return array(o.array as string) ? "the length of an array that grows" : undefined;
      case "pop": return "pop()";
      case "running": return "a task's running";
      case "taskHandle": return "a task";
      case "edge": return `${o.edge as string}()`;
      case "unitField": return `a unit's ${o.field as string}`;
      case "unitPart": return "a unit's place in the game's memory";
      case "unitAlive": return "whether a unit is alive";
      case "unitSame": return "two units compared";
      case "unitFlag": return `a unit's flag ${o.flag as string}`;
      case "unitNull": case "unitVar": case "pick": case "unitAt": case "selected": return "a unit";
      case "textLength": return "a text's length";
      case "textIndexOf": return "a search in a text";
      case "textCode": return "a character's code";
      case "textCompare": return "two texts compared";
      case "textTest": return `a text's ${o.test as string}`;
      case "textSlice": return "a part of a text (slice)";
      case "textPad": return "a text padded (padStart, padEnd)";
      case "textRepeat": return "a text repeated";
      case "textTernary": return "a ?: of texts";
      case "template": return "a text made while the game runs";
      case "textCall": {
        // (A method of a text the front end writes as a function of its own — `trim()` — or a function of the script's.)
        const name = (o.call as { name: string }).name;
        if (!TEXT_METHODS.has(name.split(".").pop()!)) return `a function that gives back a text (${name})`;
        return name.includes(".") ? `${name}()` : `a text's ${name}()`;
      }
      case "textVar": case "textOf": case "textAt": case "built":
        return "a text of the program's";
      case "ternary": {
        const t = o.whenTrue as { kind: string; value?: unknown; id?: string };
        const boolean = boolOnly.has(t.kind) || typeof t.value === "boolean" || (t.kind === "var" && decls.get(t.id!)?.kind === "boolean");
        return boolean ? "a ?: of booleans" : undefined;
      }
      case "var": return typeof o.id === "string" ? variable(o.id) : undefined;
      case "element": return array(o.array as string);
      default: return undefined;
    }
  };
  // Statements: what each kind is, before what is in it.
  const statement = (t: Stmt): string | undefined => {
    switch (t.kind) {
      case "action": {
        if (t.record.type === SET_DEATHS_ACTION && t.record.player > LAST_GROUP) return "a write of memory (setMemory())";
        const name = `the action ${actionDef(t.record.type)?.name ?? t.record.type}`;
        return t.variables?.length ? `${name}, its fields from values` : t.text ? `${name}, its text the program's` : name;
      }
      case "tableWrite": return `a write of ${t.cell.name}`;
      case "centerLocation": return "a location moved (centerLocation)";
      case "select": return "select()";
      case "syncSend": return "sync()";
      case "push": return "push()";
      case "pop": return "pop()";
      case "setLength": return "an array's length set";
      case "assignText": case "storeText": case "releaseText": return "a text of the program's";
      case "textLoop": return "a loop over a text";
      case "buildText": return "JSX made while the game runs";
      case "assignUnit": return "a unit kept in a variable";
      case "unitLoop": return t.source ? `units an event gives (${t.source})` : "a loop over units";
      case "unitWrite": return `a unit's ${t.field} written`;
      case "unitDo": return `a unit's verb (${t.verb.do})`;
      case "start": {
        // (`on.*` is a task that listens: say which.)
        const on = t.listen?.source ? { created: "on.created", died: "on.died", killed: "on.killed", ordered: "on.order", morphed: "on.morphed" }[t.listen.source] : t.listen?.inputs?.length ? (t.listen.inputs[0].source === "chat" ? "on.chat" : "on.key") : undefined;
        return on ? `an event handled (${on})` : "a task started";
      }
      case "cancel": return "a task cancelled";
      case "parallel": return t.mode === "race" ? "Promise.race or Promise.any" : "Promise.all";
      case "try": return "try";
      case "throw": return "throw";
      case "uncaught": return "an error nothing catches";
      case "print": return t.position === "center" ? "a text at the centre of the screen" : undefined;
      case "declare": case "assign": case "assignBool": return variable(t.kind === "declare" ? t.decl.id : t.target);
      case "declareArray": case "store": return array(t.array);
      default: return undefined;
    }
  };
  let found: string | undefined;
  const walk = (x: unknown): void => {
    if (found || !x || typeof x !== "object") return;
    if (Array.isArray(x)) { x.forEach(walk); return; }
    const o = x as Record<string, unknown>;
    // (A statement says what it is before what is in it; an expression after, so that the innermost part is named.)
    const isStmt = "label" in o && typeof o.kind === "string" && STATEMENT_KINDS.has(o.kind);
    if (isStmt) found = statement(o as unknown as Stmt);
    // (What is read of a unit says more than the unit: `u.hp` is "a unit's hp", not "a unit kept in a variable".)
    else if (typeof o.kind === "string" && UNIT_READS.has(o.kind)) found = node(o);
    for (const [k, v] of Object.entries(o)) if (k !== "at" && k !== "original" && v && typeof v === "object") walk(v);
    if (!found && !isStmt && typeof o.kind === "string") found = node(o);
  };
  walk(s);
  return found;
}

/** What is read of a unit, and what is done to a text: named before the unit or the text it is done to. */
const UNIT_READS = new Set(["unitField", "unitFlag", "unitAlive", "unitSame", "unitPart", "textLength", "textIndexOf", "textCode", "textCompare", "textTest", "textSlice", "textPad", "textRepeat", "textTernary", "textCall"]);
/** The methods of a text the front end writes as functions of its own (`textCall`). */
const TEXT_METHODS = new Set(["toUpperCase", "toLowerCase", "toLocaleUpperCase", "toLocaleLowerCase", "trim", "trimStart", "trimEnd", "replace", "replaceAll", "split", "join", "at", "charAt", "concat", "parseInt", "Number"]);
/** Deaths and Set Deaths, which `memory()` and `setMemory()` are when their player is past the groups (26). */
const DEATHS_CONDITION = 15, SET_DEATHS_ACTION = 45, LAST_GROUP = 26;

/** The kinds of statement, told apart from the expressions of the same name (`pop`, `call`). */
const STATEMENT_KINDS = new Set(["declare", "assignText", "storeText", "releaseText", "textLoop", "assign", "declareArray", "store", "push", "setLength", "assignBool", "assignUnit", "unitLoop", "unitWrite", "unitDo", "tableWrite", "if", "while", "do", "for", "unrolled", "switch", "break", "continue", "return", "sleep", "parallel", "start", "cancel", "action", "syncSend", "select", "centerLocation", "print", "buildText", "block", "try", "throw", "uncaught", "remark", "graph"]);

// ── what the emitter takes ──

class Scope {
  /** Every variable a taken statement reads or writes, and those it declares. */
  read = new Set<string>();
  written = new Set<string>();
  declared = new Set<string>();
  /** Why the last statement looked at was not taken. */
  why = "";
  /** A map of our own: why each statement it refuses is refused (`island`), and whether that is a part it never takes. */
  whyOf = new Map<Stmt, { why: string; never: boolean }>();
  /** A map of our own: the slot of the program's owner, the current player while it runs. */
  owner: number | undefined;
  readonly decls: Map<string, VarDecl>;
  constructor(decls: Map<string, VarDecl>) {
    this.decls = decls;
  }

  num(e: NumExpr): boolean {
    const l = linear(e);
    if (!l) return this.no(`a ${e.kind === "binary" ? `${e.op} ` : ""}${e.kind}`);
    for (const t of l.terms) {
      if (!this.ok(t.id)) return this.no(`the variable ${this.decls.get(t.id)?.name ?? t.id}`);
      this.read.add(t.id);
    }
    return true;
  }

  bool(e: BoolExpr): boolean {
    switch (e.kind) {
      case "const": return true;
      case "compare": {
        if (e.unsigned === "left" || e.unsigned === "right") return this.bool(plain(e));
        // (A map of our own: a cell of an array it keeps against a constant, as 32 bits — `Rewriter.cellCompare`'s.)
        if (e.left.kind === "element" && this.native) {
          const t = e.right.kind === "const" && e.unsigned === true ? this.cellAt(e.left.array, e.left.index) : null;
          if (!t?.jump) return this.no("a cell compared otherwise than with a constant, as 32 bits");
          for (const x of t.index.terms) this.read.add(x.id);
          return true;
        }
        const sm = signedMask(e);
        if (sm) return this.bool(sm);
        const a = side(e.left), b = side(e.right);
        if (!a || !b) return this.no("a comparison of more than a variable and a constant");
        // (Bits under a mask, against a constant only.)
        if (("mask" in a && a.mask !== undefined && !("k" in b)) || ("mask" in b && b.mask !== undefined && !("k" in a))) return this.no("bits under a mask against a variable");
        // (A signed reading of bits under a mask that has the sign bit is not one condition.)
        if (e.unsigned !== true && e.op !== "==" && e.op !== "!=" && [a, b].some((x) => "mask" in x && x.mask !== undefined && x.mask >= SIGN)) return this.no("bits under a mask with the sign bit, ordered as signed");
        for (const x of [a, b]) if ("id" in x) {
          if (!this.ok(x.id)) return this.no(`the variable ${this.decls.get(x.id)?.name ?? x.id}`);
          this.read.add(x.id);
        }
        return true;
      }
      case "test": return this.bool(notZero(e.expr));
      case "var": return this.bool(notZero({ kind: "var", id: e.id }));
      case "and": case "or": return e.items.every((x) => this.bool(x));
      case "not": return this.bool(e.expr);
      default: return this.no(`a ${e.kind}`);
    }
  }

  no(why: string): false {
    this.why ||= why;
    return false;
  }

  ok(id: string): boolean {
    if (isTemp(id)) return true;
    const d = this.decls.get(id);
    // (A boolean is a cell holding 1 or 0, as a number is.)
    return !!d && (d.kind === "number" || d.kind === "boolean") && !d.bits && d.task === undefined && !d.held;
  }

  stmts(list: Stmt[], inLoop: boolean): boolean {
    return list.every((s) => this.stmt(s, inLoop));
  }

  /** The statements left to the Python side, inside a taken loop: what each may write. */
  islands = new Map<Stmt, Set<string>>();
  /** Of an island that stores one value into a variable, the most it can be (value ranges, never below zero). */
  tops = new Map<Stmt, number>();
  /** A map of our own (`emitBody`): a print of a text known when the map is built is the game's Display Text. */
  native = false;
  /** A `for` loop's counters (what its update sets), whose arrays the Python side reads through registers of its own. */
  counters: Set<string>[] = [];
  /**
   * The variables some element of an array is read or stored at: the Python side may keep a counter's offset into its
   * arrays beside it (`Place`), stepped by its own lowering of each store — two more places of the variable, 72 and
   * 18 times it, which the graph's writes keep too.
   */
  indexed = new Set<string>();
  functions = new Map<string, FuncDecl>();
  /** The program's arrays, by id. */
  arrays = new Map<string, ArrayDecl>();
  /**
   * The statements whose value reads cells of lists known when the map is built: each cell read into a variable of
   * the emitter's own first (`reads`), the value a sum of those and the program's variables.
   */
  tables = new Map<Stmt, { reads: CellRead[]; value: Linear }>();
  cells = 0;
  /** The statements whose value is a fixed-point product or quotient the graph calls the Python side's function for. */
  calls = new Map<Stmt, { fn: FixedFn; args: Linear[] }>();
  /** The stores into cells of the program's arrays the emitter makes: the array, the index, the value (cells first). */
  stores = new Map<Stmt, Store>();
  /**
   * The variables the plan is likely to copy into their places rather than write there: each set from more than a sum
   * (a product, a quotient, a cell, a call's result) or from itself times anything but 1. A field holding a multiple of
   * one is filled a bit at a time on each copy, so a product reads it only where it is (`Emitter.product`).
   */
  heavy = new Set<string>();
  /**
   * A map of our own: a called function's body as the emitter takes it (rewritten once, `emitBody`), and whether each
   * function met so far is taken (`walking` while its body is looked at: a call of it then is a call of itself).
   */
  bodyOf?: (id: string) => Stmt[] | undefined;
  taken = new Map<string, boolean | "walking">();
  /** What a `return` gives back where it stands: the kind of the function or inlined call around it, innermost last. */
  returning: string[] = [];
  /** Whether a call that may come back into its own function is taken: the program then keeps a stack. */
  recursion = false;

  /**
   * A call in a map of our own: its arguments written into the function's parameters, which are variables like any
   * other, and its result copied into the call's own; a called function's body looked at once, an inlined call's body
   * where it is. A call that may come back into the function it is in keeps that function's variables on the stack
   * around it (`saves`): numbers and booleans, not an array's handle.
   */
  call(c: Call): boolean {
    if (c.saves) {
      if (c.saves.arrays.length) return this.no(`a growing array declared in ${c.saves.within}, which calls itself`);
      for (const id of c.saves.vars) if (!this.ok(id)) return this.no(`the variable ${this.decls.get(id)?.name ?? id} of ${c.saves.within}, which calls itself`);
      this.recursion = true;
    }
    for (const p of c.params) {
      const d = p.decl;
      if (!this.ok(d.id)) return this.no(`the parameter ${d.name}, a ${d.kind}`);
      if (d.kind === "boolean" ? !this.test(p.init as BoolExpr) : !this.lowers(p.init as NumExpr)) return this.no(`the value given to ${d.name}`);
      if (d.kind !== "boolean") this.num(p.init as NumExpr);
      this.declared.add(d.id);
      this.written.add(d.id);
    }
    if (c.result) {
      if (!this.ok(c.result.decl.id)) return this.no(`a call that gives back a ${c.result.kind}`);
      this.heavy.add(c.result.decl.id);
      this.declared.add(c.result.decl.id);
      this.written.add(c.result.decl.id);
    }
    if (c.fn !== undefined) return this.function(c.fn);
    this.returning.push(c.result?.kind ?? "void");
    try {
      return this.stmts(c.body, false);
    } finally {
      this.returning.pop();
    }
  }

  /** A called function: its body, looked at once (a call of it inside that body is taken as the body is). */
  function(id: string): boolean {
    const f = this.functions.get(id), state = this.taken.get(id);
    if (state === "walking") return true;
    if (state !== undefined) return state || this.no(`a call of ${f?.name ?? id}`);
    const body = this.bodyOf?.(id);
    if (!f || !body) return this.no(`a call of ${id}`);
    this.taken.set(id, "walking");
    let ok = true;
    if (f.result) {
      if (!this.ok(f.result.decl.id)) ok = this.no(`${f.name}, which gives back a ${f.result.kind}`);
      this.declared.add(f.result.decl.id);
      this.written.add(f.result.decl.id);
    }
    this.returning.push(f.result?.kind ?? "void");
    ok = ok && this.stmts(body, false);
    this.returning.pop();
    this.taken.set(id, ok);
    return ok;
  }

  /**
   * A part of a printed text a map of our own takes: a text, a whole number (signed or a `u32`) the emitter lowers, a
   * byte from one (a colour code chosen as the map is played). Not yet a fixed number, a player's name or colour, a
   * text of the program's.
   */
  printed(p: TextPart): boolean {
    if (p.kind === "text") return true;
    if (p.kind === "number" && p.fixed) return this.no("a fixed number printed");
    if (p.kind !== "number" && p.kind !== "char") return this.no(`a printed ${p.kind === "value" ? "text of the program's" : p.kind === "name" ? "player's name" : "player's colour"}`);
    if (!this.lowers(p.expr)) return this.no("a printed value it does not lower");
    this.num(p.expr);
    this.prints = true;
    return true;
  }

  /** Whether a text printed with a number in it is taken: the map then has the routine that writes one as digits. */
  prints = false;

  /** A `return` of a function or an inlined call the emitter lays out: its value one the emitter lowers. */
  returned(s: Extract<Stmt, { kind: "return" }>): boolean {
    const kind = this.returning[this.returning.length - 1];
    if (s.value === undefined || kind === "void") return true;
    if (kind === "boolean") return this.test(s.value as BoolExpr) || this.no("a value given back that it does not lower");
    if (kind !== "number" || !this.lowers(s.value as NumExpr)) return this.no("a value given back that it does not lower");
    this.num(s.value as NumExpr);
    return true;
  }

  /**
   * `fmul` / `fdiv` of numbers the emitter lowers: which of the Python side's functions (part 3) gives the same bits,
   * and its arguments. A constant side goes into the function (one above zero; below, the statement is the Python
   * side's, whose negation after is not this).
   */
  fixed(e: NumExpr): { fn: FixedFn; args: Linear[] } | null {
    if (e.kind !== "intrinsic" || (e.name !== "fmul" && e.name !== "fdiv") || e.args.length !== 2) return null;
    const [a, b] = e.args.map((x) => linear(x));
    if (!a || !b || ![...a.terms, ...b.terms].every((t) => this.ok(t.id))) return null;
    const known = (l: Linear) => l.terms.length === 0;
    const positive = (l: Linear) => l.c > 0 && l.c < SIGN;
    if (known(a) && known(b)) return null;
    let out: { fn: FixedFn; args: Linear[] } | null;
    if (e.name === "fmul") {
      out = known(b) ? (positive(b) ? { fn: { fn: "fmul_by", c: b.c }, args: [a] } : null)
        : known(a) ? (positive(a) ? { fn: { fn: "fmul_by", c: a.c }, args: [b] } : null)
        : { fn: { fn: "fmul_vars" }, args: [a, b] };
    } else {
      out = known(a) ? (positive(a) ? { fn: { fn: "fdiv_by", c: a.c }, args: [b] } : null)
        : known(b) ? (positive(b) ? { fn: { fn: "fdiv_by_const", c: b.c }, args: [a] } : null)
        : { fn: { fn: "fdiv_vars" }, args: [a, b] };
    }
    if (out) for (const l of out.args) for (const t of l.terms) this.read.add(t.id);
    return out;
  }

  /** A number the emitter lowers with cells of lists read first; its reads noted. Null when it does not. */
  withCells(e: NumExpr): { reads: CellRead[]; value: Linear } | null {
    const reads: CellRead[] = [];
    const value = linear(e, (el, sides) => {
      if (el.kind === "element") {
        const t = this.table(el);
        if (!t) return null;
        const id = `@cell${this.cells++}`;
        reads.push({ id, table: t });
        return id;
      }
      if (el.op === "*" || el.op === "/" || el.op === "%") {
        // (A map of our own: the emitter's own product and division, `Emitter.arith`.)
        if (!this.native || !sides || ![...sides[0].terms, ...sides[1].terms].every((t) => t.id.startsWith("@cell") || this.ok(t.id))) return null;
        const id = `@cell${this.cells++}`;
        const range = (x: NumExpr) => (x as NumExpr & { range?: Range }).range;
        const [ra, rb, r] = [range(el.left), range(el.right), range(el)];
        reads.push({ id, arith: { op: el.op, a: sides[0], b: sides[1], unsigned: !!el.unsigned, ...(ra ? { ra } : {}), ...(rb ? { rb } : {}), ...(r ? { r } : {}) } });
        return id;
      }
      const of = linear(el.left), by = linear(el.right);
      if (!of || !by || by.terms.length || by.c < 1 || by.c > 31 || !of.terms.every((t) => this.ok(t.id))) return null;
      const id = `@cell${this.cells++}`;
      // (Value ranges: a number never below zero and at most `top` has only top's bits to test, and its >> is >>>.)
      const r = (el.left as NumExpr & { range?: [number, number] }).range;
      const top = r && r[0] >= 0 ? r[1] : undefined;
      reads.push({ id, shift: { of, by: by.c, signed: el.op === ">>" && top === undefined, ...(top !== undefined ? { top } : {}) } });
      return id;
    });
    if (!value || !value.terms.every((t) => t.id.startsWith("@cell") || this.ok(t.id))) return null;
    for (const t of [...value.terms, ...reads.flatMap((r) => (r.table ? r.table.index.terms : r.shift ? r.shift.of.terms : [...r.arith!.a.terms, ...r.arith!.b.terms]))]) if (!t.id.startsWith("@cell")) this.read.add(t.id);
    return { reads, value };
  }

  /**
   * A cell of a list the script computed when it was built (`values`, which nothing writes), at an index the emitter
   * lowers: read where it is, a condition a bit of the values, its address a place of the index. Null otherwise.
   */
  table(e: NumExpr): Table | null {
    if (e.kind !== "element") return null;
    const a = this.arrays.get(e.array) as (ArrayDecl & { packed?: unknown }) | undefined;
    if (this.native) return this.cellAt(e.array, e.index);
    if (!a || a.kind !== "number") return null;
    const index = linear(e.index);
    if (!index || !index.terms.every((t) => this.ok(t.id))) return null;
    if (!a.values) {
      // An array the program writes: a jump into its cell (the Python side's EUDVArray, a cell every 72 bytes).
      return storable(a) && a.length <= VARRAY_MOST ? { array: a, index, jump: true } : null;
    }
    if (a.texts || a.dynamic || a.slice || a.through || a.task !== undefined) return null;
    // A trigger a bit the values have: worth it for small numbers (a maze's cells); a jump into the cell for wider
    // ones, when the Python side keeps them as an EUDVArray (a long list is dwords, packed: no cells to jump into).
    const bits = a.values.reduce((m, v) => (m | (v >>> 0)) >>> 0, 0).toString(2).replace(/0/g, "").length;
    if (bits <= TABLE_BITS) return { array: a, index };
    return a.values.length < PACK_FROM ? { array: a, index, jump: true } : null;
  }

  /**
   * A cell of an array of a map of our own, at an index the emitter lowers: the array's region of cell triggers (a
   * window's, the array it is a window on, at its offset), a guard that the index is inside the array (a window: its
   * own length). A list known when the map is built whose values have few bits between them is read a bit at a time,
   * where it is, as in the Python side's maps. Null for an array whose cells are not a region's: one that grows, holds
   * texts, is a task's, or saturates (`u8`, `u16`).
   */
  cellAt(array: string, at: NumExpr): Table | null {
    const a = this.arrays.get(array);
    const index = linear(at);
    if (!a || !index || !index.terms.every((t) => this.ok(t.id)) || !nativeArray(a)) return null;
    // (What the value ranges know of the index, as the Python side has it: inside, and there is nothing to test.)
    const r = (at as NumExpr & { range?: readonly [number, number] }).range;
    const safe = !!r && r[0] >= 0 && r[1] < a.length;
    if (a.slice) {
      const of = this.arrays.get(a.slice.of);
      if (!of || !nativeArray(of) || of.slice || !this.ok(a.slice.offset)) return null;
      return { array: of, index: merged(index.c, [...index.terms, { id: a.slice.offset, k: 1 }]), jump: true, guard: index, limit: a.length, ...(safe ? { safe } : {}) };
    }
    if (a.values) {
      const bits = a.values.reduce((m, v) => (m | (v >>> 0)) >>> 0, 0).toString(2).replace(/0/g, "").length;
      if (bits <= TABLE_BITS) return { array: a, index };
    }
    return { array: a, index, jump: true, ...(safe ? { safe } : {}) };
  }

  /**
   * A statement the emitter does not lower, left to the Python side where it is (an *island*): taken when nothing in
   * it leaves it — no `break` or `continue` of a loop outside it, no `return`, no wait — and it reads no array at a
   * `for` loop's counter (the Python side has registers for that, part 2). What it may write is copied back into the
   * places of the graph's after it: its own writes, those of the functions it calls.
   */
  island(s: Stmt): boolean {
    // (A map of our own refuses every island, so whether the Python side could lower this one where it is — the walk
    // below — is not the question: what it is, in a script's words, is.)
    const named = this.native ? unlowered(s, this.decls, this.arrays) : undefined;
    let ok = true;
    // (`loops`: the loops around, inside the statement; `breaks`: those and the switches, which a break also ends.)
    const walk = (x: unknown, loops: number, breaks = loops): void => {
      if (!ok || !x || typeof x !== "object") return;
      if (Array.isArray(x)) { x.forEach((y) => walk(y, loops, breaks)); return; }
      const o = x as Record<string, unknown>;
      switch (o.kind) {
        case "break": if (breaks === 0) ok = this.no("a break out of a statement it cannot lower"); break;
        case "continue": if (loops === 0) ok = this.no("a continue out of a statement it cannot lower"); break;
        // (A variable of the rewriter's has no cell on the Python side: a statement that reads one is not left to it.)
        case "var": if (typeof o.id === "string" && isTemp(o.id)) ok = this.no("a value computed ahead, read by a statement it cannot lower"); break;
        case "return": case "sleep": case "parallel": case "start": case "try": case "throw": case "uncaught": case "graph":
          ok = this.no(`a ${o.kind} in a statement it cannot lower`);
          break;
        case "element": case "store":
          if (this.counters.some((c) => [...readIn(o.index as NumExpr)].some((id) => c.has(id)))) ok = this.no("an array read at the loop's counter");
          break;
      }
      const inner = o.kind === "while" || o.kind === "for" || o.kind === "do" || o.kind === "unitLoop" || o.kind === "textLoop" || o.kind === "unrolled";
      for (const v of Object.values(o)) if (v && typeof v === "object") walk(v, loops + (inner ? 1 : 0), breaks + (inner || o.kind === "switch" ? 1 : 0));
    };
    if (!named) walk(s, 0);
    if (this.native) {
      // (What in it the emitter never takes; else what the walk found, or the checks' own reason since the island before.)
      this.whyOf.set(s, { why: named ?? this.why, never: named !== undefined });
      this.why = "";
      ok = true;
    }
    if (!ok) return false;
    this.islands.set(s, writes(s, this.functions));
    // (What value ranges know of what it stores, for the copies after it.)
    const value = s.kind === "assign" ? s.value : s.kind === "declare" ? (s.init as NumExpr) : undefined;
    const r = (value as (NumExpr & { range?: [number, number] }) | undefined)?.range;
    if (r && r[0] >= 0) this.tops.set(s, r[1]);
    return true;
  }

  stmt(s: Stmt, inLoop: boolean): boolean {
    switch (s.kind) {
      case "remark": return true;
      case "block": return this.stmts(s.body, inLoop);
      case "declare": {
        if (!this.ok(s.decl.id)) return this.island(s);
        if (s.decl.kind === "boolean") {
          if (!this.test(s.init as BoolExpr)) return this.island(s);
          this.declared.add(s.decl.id);
          this.written.add(s.decl.id);
          return true;
        }
        const call = isTemp(s.decl.id) ? null : this.fixed(s.init as NumExpr);
        if (call) this.calls.set(s, call);
        else if (!this.lowers(s.init as NumExpr)) {
          const t = this.withCells(s.init as NumExpr);
          if (!t) return this.island(s);
          this.tables.set(s, t);
        } else this.num(s.init as NumExpr);
        this.weigh(s.decl.id, s.init as NumExpr, this.tables.get(s));
        this.declared.add(s.decl.id);
        this.written.add(s.decl.id);
        return true;
      }
      case "assign": {
        if (!this.ok(s.target)) return this.island(s);
        // (A call's result goes into a cell: never one of the emitter's own variables.)
        const call = isTemp(s.target) ? null : this.fixed(s.value);
        if (call) this.calls.set(s, call);
        else if (!this.lowers(s.value)) {
          const t = this.withCells(s.value);
          if (!t) return this.island(s);
          this.tables.set(s, t);
        } else this.num(s.value);
        this.weigh(s.target, s.value, this.tables.get(s));
        this.written.add(s.target);
        return true;
      }
      case "assignBool": {
        if (!this.ok(s.target) || !this.test(s.value)) return this.island(s);
        this.written.add(s.target);
        return true;
      }
      case "switch": {
        const v = side(s.value);
        if (!v || ("mask" in v && v.mask !== undefined) || s.cases.some((c) => c.value !== null && typeof c.value !== "number")) return this.island(s);
        if ("id" in v) {
          if (!this.ok(v.id)) return this.island(s);
          this.read.add(v.id);
        }
        // (A break inside ends the switch; a continue is the loop's around it.)
        return s.cases.every((c) => this.stmts(c.body, true));
      }
      case "unrolled": return s.iterations.every((it) => this.stmts(it, true));
      case "if": return this.test(s.cond) ? this.stmts(s.then, inLoop) && this.stmts(s.else ?? [], inLoop) : this.island(s);
      case "while": return (!s.cond || this.test(s.cond)) ? this.stmts(s.body, true) : this.island(s);
      case "do": return this.test(s.cond) ? this.stmts(s.body, true) : this.island(s);
      case "for": {
        if (s.cond && !this.test(s.cond)) return this.island(s);
        this.counters.push(writtenIn(s.update));
        const ok = this.stmts(s.update, true) && this.stmts(s.body, true);
        this.counters.pop();
        return ok;
      }
      case "store": {
        if (this.native) {
          const cell = this.cellAt(s.array, s.index);
          if (!cell?.jump) return this.no("a store into an array a map of our own does not keep") || this.island(s);
          const value: { reads: CellRead[]; value: Linear } | null = this.lowers(s.value as NumExpr) ? { reads: [], value: linear(s.value as NumExpr)! } : this.withCells(s.value as NumExpr);
          if (!value) return this.island(s);
          for (const t of [...cell.index.terms, ...value.value.terms]) if (!t.id.startsWith("@cell")) this.read.add(t.id);
          this.stores.set(s, { array: cell.array, index: cell.index, ...value, ...(cell.guard ? { guard: cell.guard, limit: cell.limit } : {}), ...(cell.safe ? { safe: true } : {}) });
          return true;
        }
        const a = this.arrays.get(s.array);
        if (!a || !storable(a) || this.counters.some((c) => [...readIn(s.index)].some((id) => c.has(id)))) return this.island(s);
        const index = linear(s.index);
        if (!index || !index.terms.every((t) => this.ok(t.id))) return this.island(s);
        const value: { reads: CellRead[]; value: Linear } | null = this.lowers(s.value as NumExpr) ? { reads: [], value: linear(s.value as NumExpr)! } : this.withCells(s.value as NumExpr);
        if (!value) return this.island(s);
        for (const t of [...index.terms, ...value.value.terms]) if (!t.id.startsWith("@cell")) this.read.add(t.id);
        this.stores.set(s, { array: a, index, ...value });
        return true;
      }
      case "break": case "continue": return inLoop;
      case "unrolled": return s.iterations.every((it) => this.stmts(it, true)) || this.island(s);
      case "sleep": return this.native || this.island(s);
      case "print":
        // (Display Text shows to the current player, the owner in a map of our own: a text for anyone else is refused
        // until a print goes to each player of its group in turn, as the Python side's does.)
        if (this.native && s.to !== PlayerGroup.CurrentPlayer && s.to !== this.owner) {
          // (TrigScript's own warning — a pool of closures or instances full — is shown to every player: say which.)
          const first = s.parts[0]?.kind === "text" ? s.parts[0].text.replace(/^[\x01-\x1f]+/, "") : "";
          const warning = first.startsWith("TrigScript: ") ? first.slice(12).split(";")[0] : undefined;
          return this.no(warning ? `a warning TrigScript shows every player ("${warning}")` : "a text shown to other players than the program's owner") || this.island(s);
        }
        if (this.native && s.position === "chat" && s.parts.every((p) => this.printed(p))) return true;
        return this.island(s);
      case "call": return (this.native && this.call(s.call)) || this.island(s);
      case "declareArray": {
        // A map of our own: the cells set from the list or the one value (`fill`), each a number the emitter lowers.
        const a = this.arrays.get(s.array);
        if (!this.native || !a || !nativeArray(a) || a.slice || a.values) return this.island(s);
        for (const v of [...(s.init ?? []), ...(s.fill ? [s.fill] : [])]) {
          if (!this.lowers(v as NumExpr)) return this.no("a cell's value it does not lower") || this.island(s);
          this.num(v as NumExpr);
        }
        return true;
      }
      case "return": return (this.native && this.returning.length > 0 && this.returned(s)) || this.island(s);
      default: return this.island(s);
    }
  }

  /**
   * A write of `target`: heavy (`heavy`) when it reads the target times anything but 1 (the plan copies it), or reads a
   * scratch cell a copy fills — a product's or a quotient's, an array's cell kept where it is — through a routed copy a
   * place (56 ns each, where a sum's or a shift's write costs 10).
   */
  weigh(target: string, value: NumExpr, t?: { reads: CellRead[] }): void {
    const l = linear(value);
    if ((l && l.terms.some((x) => x.id === target && x.k !== 1)) || t?.reads.some((r) => r.arith || r.table?.jump)) this.heavy.add(target);
  }

  /** Whether the emitter lowers this number (without noting anything). */
  lowers(e: NumExpr): boolean {
    const l = linear(e);
    return !!l && l.terms.every((t) => this.ok(t.id));
  }

  /** Whether the emitter lowers this test; its reads noted when it does. */
  test(e: BoolExpr): boolean {
    const why = this.why;
    const ok = this.bool(e);
    if (!ok) this.why = why;
    return ok;
  }
}

// ── the layout ──

/** A write of a variable, laid out where the statement was, expanded once every place of the variable is known. */
interface Write { target: string; value: Linear; at?: At }
/** An action of an expanded write: it writes `into`; a variable it reads plus a constant is in its own number. */
interface WriteAct { into: Place; modifier: "set" | "add"; value: Num; reads?: Read }
/**
 * What an action's or a condition's number holds: the variable times `scale`, plus `add` (wrapping) — plus, with
 * `base`, the EPD of that array's first cell (a condition's player field reading a cell at an index).
 */
interface Read { id: string; scale: number; add: number; base?: string }
/**
 * A cell of an array at an index the emitter lowers: of a list known when the map is built, read a bit at a time where
 * it is; or (`jump`) of an EUDVArray, the walk sent into the cell, which writes its value out through eudplib's getter.
 */
/**
 * `guard`, `limit`: the index a window is read at is inside it when `guard` is below `limit` (unset: the array's own).
 * `safe`: the value ranges know the index is inside, and nothing is tested.
 */
interface Table { array: ArrayDecl; index: Linear; jump?: boolean; guard?: Linear; limit?: number; safe?: boolean }
/** A sum the emitter lowers shifted right by a constant: `>>` keeps the sign, `>>>` reads from 0 up. */
/** `top`: the most the shifted number can be, when value ranges know it never below zero (only its bits are tested). */
interface Shift { of: Linear; by: number; signed: boolean; top?: number }
/**
 * A product of two numbers the emitter lowers, or a quotient or a remainder of two (TrigScript 4, step 4 of the way off
 * eudplib): `unsigned` reads both sides from 0 up (`u32`), else as JavaScript's numbers, a quotient towards zero and a
 * remainder with the dividend's sign; by 0 both are 0, as the simulator has them. `ra`, `rb`, `r`: what the value
 * ranges know of each side and of the answer.
 */
interface Arith { op: "*" | "/" | "%"; a: Linear; b: Linear; unsigned: boolean; ra?: Range; rb?: Range; r?: Range }
/** A variable times a constant plus a constant: what a field holding a multiple of a sum reads. */
interface Multiple { id: string; k: number; c: number }
/**
 * The most bits a product's tested side may have for the other side's multiples to be fields of its own (`product`):
 * each one more place of that side, which its writes fill.
 */
const SCALED_BITS = 8;
/** How many bits a number of this range has, read from 0 up: 32 when it may be below zero. */
const width = (r?: Range) => (r && r[0] >= 0 ? (r[1] <= 0 ? 0 : 32 - Math.clz32(r[1])) : 32);
/** Something a value reads first, into a variable of the emitter's own: a cell, a shift, a product or a quotient. */
type CellRead = { id: string; table?: Table; shift?: Shift; arith?: Arith };
/** A store into a cell of one of the program's arrays: its index, and its value with the cells it reads first. */
interface Store { array: ArrayDecl; index: Linear; reads: CellRead[]; value: Linear; guard?: Linear; limit?: number; safe?: boolean }
/** (`at` on a copy or a call: the statement it is for, when its trigger is another's.) */
/** (`label`: every place of `target` set to where `to` is — where a function that calls itself goes back to.) */
/** (`route`: a variable's cell into these dwords, and nothing else of its places.) */
type Item = { act: Act } | { write: Write } | { fill: { temp: string; target: string; apart?: boolean; top?: number } } | { copy: string; at?: At } | { island: Stmt; writes: Set<string> } | { bump: { target: string; add: number } } | { call: { fn: FixedFn; target: string }; at?: At } | { label: { target: string; to: string } } | { route: { from: string; into: Dword[] } };
/** `keep`: an empty trigger that stays (a jump whose next pointer a place sets). */
interface Proto { label: string; conds: Cond[]; items: Item[]; next?: string; at?: At; depth?: number; keep?: boolean }

/**
 * A place of a variable: a dword that holds it times `scale` plus `add` (wrapping) — known (its cell, a home, a
 * condition's number) or the number of an action of an expanded write, found when the triggers are cut.
 */
interface Place { dword?: Dword; act?: WriteAct; scale: number; add: number; base?: string; synced?: boolean }

/**
 * The byte a printed text's template fills where nothing goes: 0x0D, a carriage return, which StarCraft draws as
 * nothing — eudplib pads its strings to whole dwords with it, and its own prints carry it around every number.
 */
const PAD = 0x0d;

/**
 * The most bits a list's values may have between them for the emitter to read its cells where they are: a trigger a
 * bit, each 13 ns when the bit is clear and 23 when set, against about 200 ns for the Python side's read of a cell.
 */
const TABLE_BITS = 6;

/** The most cells a map of our own's stack has: a trigger of 72 bytes each (4.7 MB at this). */
const STACK_CELLS_MOST = 65536;

/** The most cells an array's EUDVArray has on the Python side (`VARRAY_MOST`, a cell every 18 EPD); past it, an EUDArray (a dword each). */
const VARRAY_MOST = 2048;
/** The EPD between one EUDVArray cell's value and the next's (72 bytes). */
const VARRAY_STRIDE_EPD = 18;

/**
 * An array whose cells the emitter stores into where they are: of numbers, one for everyone, its cells the Python
 * side's own (not a list known when the map is built, not one that grows, not a window on another, not a task's, not
 * `u8` / `u16`, whose stores saturate).
 */
function storable(a: ArrayDecl): boolean {
  const x = a as ArrayDecl & { packed?: unknown; slice?: unknown; through?: unknown };
  return a.kind === "number" && !a.values && !a.texts && !a.dynamic && !x.slice && !x.through && !x.packed && a.task === undefined && !a.bits;
}

/** An array a map of our own keeps as a region of cell triggers, read by a jump into a cell (`Scope.cellAt`'s). */
function inRegion(arrays: Map<string, ArrayDecl>, id: string): boolean {
  const a = arrays.get(id);
  if (!a || !nativeArray(a)) return false;
  if (a.slice) {
    const of = arrays.get(a.slice.of);
    return !!of && nativeArray(of) && !of.slice;
  }
  if (a.values) return a.values.reduce((m, v) => (m | (v >>> 0)) >>> 0, 0).toString(2).replace(/0/g, "").length > TABLE_BITS;
  return true;
}

/**
 * An array a map of our own keeps in a region of cell triggers (or reads where it is: a list of few bits): of numbers or
 * booleans, one for everyone — not one that grows, holds texts, is a task's, or saturates (`u8`, `u16`). A window on
 * one (a row of a grid) is the array it is a window on.
 */
function nativeArray(a: ArrayDecl): boolean {
  return (a.kind === "number" || a.kind === "boolean") && !a.dynamic && !a.texts && !a.through && a.task === undefined && !a.bits;
}

/** The fixed-point functions the emitter makes as its own triggers rather than calling the Python side's. */
const NATIVE = { fdiv_by: true };

/** A sum as an expression again (to test its sign). */
function linearExpr(l: Linear): NumExpr {
  const at = { line: 0, column: 0 } as At;
  let e: NumExpr | null = null;
  for (const t of l.terms) {
    const term: NumExpr = t.k === 1 ? { kind: "var", id: t.id } : { kind: "binary", op: "*", left: { kind: "var", id: t.id }, right: { kind: "const", value: t.k }, at, label: "" };
    e = e ? { kind: "binary", op: "+", left: e, right: term, at, label: "" } : term;
  }
  if (!e) return { kind: "const", value: l.c };
  return l.c ? { kind: "binary", op: "+", left: e, right: { kind: "const", value: l.c }, at, label: "" } : e;
}

/** A constant plus an array's first cell's EPD, as an action's number. */
/** (A base `addr:<id>` is the address of an array's first cell, a trigger; any other the EPD of its first cell's value.) */
const num = (n: number, base?: string): Num => (!base ? n : base.startsWith("addr:") ? { addrOf: base.slice(5), plus: n } : { epdOf: base, plus: n });

class Emitter {
  protos: Proto[] = [];
  n = 0;
  places = new Map<string, Place[]>();
  /** Every write of each variable. */
  writes = new Map<string, Write[]>();
  /** The branches to put back when the walk reaches a label: the branch, and the label it goes to otherwise. */
  restores = new Map<string, { branch: string; to: string }[]>();
  homes = new Set<string>();
  /** A comparison's number that reads a variable: a place of it once the condition is in its trigger. */
  condReads = new Map<Cond, Read>();
  /** A condition whose player field is a place of what it reads: the index of a table's cell. */
  condPlayers = new Map<Cond, Read>();
  /** A jump into an EUDVArray's cell: its trigger's next pointer, a place of the index. */
  jumpReads = new Map<string, Read>();
  /** A store's action: its destination a place of the index, its number (when not a constant) a place of the value. */
  actPlaces = new Map<Act, { dest?: Read; value?: Read }>();
  /** The variables of the emitter's own (a table's index), which have no cell on the Python side. */
  own = new Set<string>();
  /** The arrays whose cells are read where they are, and the EPD from one cell's value to the next's. */
  arrays = new Map<string, number>();
  loops: { cont: string; exit: string }[] = [];
  /** The statement being laid out: where its triggers say they come from (the cost of a line, the map of triggers). */
  at?: At;
  /** The variables copied whatever the plan says: a table's target with more places than a trigger has actions. */
  forced = new Set<string>();
  /** The variables of the emitter's own that stand for one of the program's in a field (`pin`): what each stands for. */
  pins = new Map<string, string>();
  /** The variables a function's result goes into: their cells take it, and a copy fills their other places. */
  results = new Set<string>();
  /** The emitter's own variables that are a function's parameter: their one place is its cell. */
  params = new Map<string, Dword>();
  /** The table targets whose places outgrew a trigger, for the emitter to try again with them copied. */
  crowded = new Set<string>();
  /**
   * A map of our own: the functions a call has reached, each laid out once after the program (`functions()`) — where
   * it starts, and the trigger it ends at, whose next pointer every call sets to where it goes on — and those still
   * to lay out. `depth`: the most loops around a call of it, which its triggers count as theirs.
   */
  fns = new Map<string, { entry: string; exit: string; depth: number }>();
  pending: string[] = [];
  /** The loops around the function being laid out, at its deepest call. */
  depthBase = 0;
  /** The function or inlined call being laid out, innermost last: the variable its `return` writes, where it goes. */
  frames: { result?: { id: string; kind: string }; end: string }[] = [];
  /**
   * A map of our own whose functions call themselves: a stack each, by function — its id, the variable of the
   * emitter's own that holds the cells in use (`sp`: what addresses the stack — a store's destination, a cell's
   * fields, a jump into one — are places of it), the most cells a frame takes — and, for them all, how many frames
   * are on the stacks (`depth`) and how deep they may go (the script's setting). A stack apart for each function
   * keeps the places of its `sp` to its own calls: one for them all had a place at every call of every function, and
   * every call wrote them all.
   */
  stacks = new Map<string, { id: string; sp: string; frame: number }>();
  stackDepth = STACK_DEPTH;
  /** The called function being laid out (`functions()`): a frame keeps where it goes back to. */
  current?: string;
  /** Of the function being laid out: what is still to be read after each of its calls that may come back. */
  live = new Map<Call, Set<string>>();
  get depth(): string { return `${this.key}.depth`; }

  /** The stack of the function a frame is the function's. */
  stackOf(fn: string): { id: string; sp: string; frame: number } {
    let st = this.stacks.get(fn);
    if (!st) {
      this.stacks.set(fn, (st = { id: `${STACK}:${fn}`, sp: `${this.key}.sp.${fn}`, frame: 0 }));
      this.own.add(st.sp);
    }
    return st;
  }

  readonly key: string;
  readonly scope: Scope;
  constructor(key: string, scope: Scope) {
    this.key = key;
    this.scope = scope;
  }

  label(what: string): string {
    return `${this.key}.${what}${this.n++}`;
  }

  placesOf(id: string): Place[] {
    let p = this.places.get(id);
    if (!p) {
      // (A variable of the emitter's own is a dword of the graph's — the Python side has no cell for it — save in a map
      // of our own, where every variable's cell is the layout's, and can be copied from.)
      this.places.set(id, (p = [{ dword: this.params.get(id) ?? ((this.own.has(id) || isTemp(id)) && !this.scope.native ? { data: `${this.key}.v.${id}` } : { var: id }), scale: 1, add: 0 }]));
      // (The Python side's offsets beside a counter an array is indexed by: kept by every write, already right on the
      // way in.)
      if (this.scope.indexed.has(id) && !this.own.has(id) && !isTemp(id)) {
        p.push({ dword: { counter: id, part: "bytes" }, scale: 72, add: 0, synced: true }, { dword: { counter: id, part: "dwords" }, scale: 18, add: 0, synced: true });
      }
    }
    return p;
  }

  /** A dword that holds the variable plus `add`, for conditions to read as memory. */
  home(id: string, add: number): Dword {
    add = u(add);
    if (add === 0) return this.placesOf(id)[0].dword!;
    const name = `${this.key}.h.${id}.${add}`;
    if (!this.homes.has(name)) {
      this.homes.add(name);
      this.placesOf(id).push({ dword: { data: name }, scale: 1, add });
    }
    return { data: name };
  }

  push(p: Omit<Proto, "label"> & { label?: string }): Proto {
    const t: Proto = { label: p.label ?? this.label("t"), conds: p.conds, items: p.items, next: p.next, at: p.at ?? this.at, depth: this.depthBase + this.loops.length, ...(p.keep ? { keep: true } : {}) };
    this.protos.push(t);
    return t;
  }

  /** A label the walk can be sent to, here: an empty trigger (puts-back and writes join it; dropped when it stays empty). */
  land(label: string): void {
    this.push({ label, conds: [], items: [] });
  }

  /** The last trigger, if it takes more actions (no conditions, the walk going on to what is next); or a new one. */
  open(): Proto {
    const last = this.protos[this.protos.length - 1];
    if (last && last.conds.length === 0 && last.next === undefined) {
      // (An empty trigger a label stands at takes the line of what fills it.)
      if (!last.items.length) last.at = this.at;
      return last;
    }
    return this.push({ conds: [], items: [] });
  }

  write(target: string, value: Linear, copy = true): void {
    const w: Write = { target, value, ...(this.at ? { at: this.at } : {}) };
    // (The copy is there for a variable that turns out to need one: the rest leave it out.)
    this.open().items.push({ write: w }, ...(copy ? [{ copy: target, ...(this.at ? { at: this.at } : {}) }] : []));
    let list = this.writes.get(target);
    if (!list) this.writes.set(target, (list = []));
    list.push(w);
  }

  /** The walk goes to `to` from here. */
  goto(to: string): void {
    const last = this.protos[this.protos.length - 1];
    if (last && last.next === undefined && last.conds.length === 0) last.next = to;
    else this.push({ conds: [], items: [], next: to });
  }

  /** A trigger whose conditions all holding send the walk to `to`; otherwise it goes on. */
  branch(conds: Cond[], to: string, at?: At): void {
    const label = this.label("b"), after = this.label("a");
    this.push({ label, conds, items: [{ act: { dword: { at: label, field: "next" }, modifier: "set", value: { label: to } } }], next: after, at });
    let r = this.restores.get(to);
    if (!r) this.restores.set(to, (r = []));
    r.push({ branch: label, to: after });
    this.land(after);
  }

  // ── comparisons ──

  /** The conditions that all hold exactly when `op` holds of the two sides, or null when one trigger cannot say it. */
  conds(op: CompareOp, a: Side, b: Side, unsigned: boolean): Cond[] | "true" | "false" | null {
    // (Equal or not is the same of the 32 bits signed or not: no bias, the variable's own cell.)
    const d = unsigned || op === "==" || op === "!=" ? 0 : SIGN;
    if ("k" in a && "k" in b) {
      const x = u(a.k + d), y = u(b.k + d);
      const r = op === "<" ? x < y : op === "<=" ? x <= y : op === ">" ? x > y : op === ">=" ? x >= y : op === "==" ? x === y : x !== y;
      return r ? "true" : "false";
    }
    if ("k" in a) return this.conds(FLIP[op], b, a, unsigned);
    if (a.mask !== undefined) {
      // The bits under the mask, read from 0 up, against the constant: a signed reading of them is the same when the
      // mask leaves the sign bit out (a constant below zero is then below them all).
      let k = (b as { k: number }).k;
      if (op === "==" || op === "!=") k = u(k);
      else {
        if (!unsigned && a.mask >= SIGN) return null;
        if (!unsigned && (k | 0) < 0) return (op === ">" || op === ">=") ? "true" : "false";
      }
      // (Bits the mask has not cannot match.)
      if ((op === "==" || op === "!=") && (k & ~a.mask) !== 0) return op === "!=" ? "true" : "false";
      const mem: Dword = this.home(a.id, 0);
      const one = (compare: Compare, value: number): Cond[] => [{ dword: mem, compare, value, mask: a.mask }];
      switch (op) {
        case "<": return k === 0 ? "false" : one("atMost", k - 1);
        case "<=": return one("atMost", k);
        case ">": return k === MAX ? "false" : one("atLeast", k + 1);
        case ">=": return one("atLeast", k);
        case "==": return one("exactly", k);
        case "!=": return k === 0 ? one("atLeast", 1) : null;
      }
    }
    if ("k" in b === false && (b as { mask?: number }).mask !== undefined) return null;
    const mem = this.home(a.id, a.c + d);
    if ("k" in b) {
      const k = u(b.k + d);
      const one = (compare: Compare, value: number): Cond[] => [{ dword: mem, compare, value }];
      switch (op) {
        case "<": return k === 0 ? "false" : one("atMost", k - 1);
        case "<=": return one("atMost", k);
        case ">": return k === MAX ? "false" : one("atLeast", k + 1);
        case ">=": return one("atLeast", k);
        case "==": return one("exactly", k);
        case "!=": return k === 0 ? one("atLeast", 1) : null;
      }
    }
    // Two variables: b plus a constant in the condition's number (one less for <, one more for >, with a second
    // condition keeping b off the end where that would wrap).
    const read = (compare: Compare, add: number): Cond => {
      const c: Cond = { dword: mem, compare, value: 0 };
      this.condReads.set(c, { id: b.id, scale: 1, add: u(b.c + d + add) });
      return c;
    };
    switch (op) {
      case "<=": return [read("atMost", 0)];
      case ">=": return [read("atLeast", 0)];
      case "==": return [read("exactly", 0)];
      case "<": return [read("atMost", -1), { dword: this.home(b.id, b.c + d), compare: "atLeast", value: 1 }];
      case ">": return [read("atLeast", 1), { dword: this.home(b.id, b.c + d), compare: "atMost", value: MAX - 1 }];
      case "!=": return null;
    }
  }

  /**
   * The condition that holds when a cell of an array a map of our own keeps is so against a constant, as 32 bits
   * (`Rewriter.cellCompare`): read where the index says, by its player field — the EPD of the first cell's number plus
   * 18 a cell, a place of the index. What tests the index inside the array comes before it, in its trigger or before it.
   */
  cellConds(e: Extract<BoolExpr, { kind: "compare" }>, when: boolean): Cond[] | "true" | "false" | null {
    const el = e.left as Extract<NumExpr, { kind: "element" }>;
    const t = this.scope.cellAt(el.array, el.index)!;
    this.region(t.array);
    const op = when ? e.op : INVERSE[e.op], k = u((e.right as { value: number }).value);
    if (op === "!=" && k !== 0) return null;
    const index = this.pin(t.index, "cx");
    const one = (compare: Compare, value: number): Cond[] => {
      const c: Cond = { dword: { element: t.array.id }, compare, value };
      this.condPlayers.set(c, { id: index, scale: VARRAY_STRIDE_EPD, add: 0, base: t.array.id });
      return [c];
    };
    switch (op) {
      case "<": return k === 0 ? "false" : one("atMost", k - 1);
      case "<=": return one("atMost", k);
      case ">": return k === MAX ? "false" : one("atLeast", k + 1);
      case ">=": return one("atLeast", k);
      case "==": return one("exactly", k);
      case "!=": return one("atLeast", 1);
    }
  }

  /** The conditions of one trigger that hold exactly when `e` is `when`, or null. */
  single(e: BoolExpr, when: boolean): Cond[] | "true" | "false" | null {
    if (e.kind === "const") return e.value === when ? "true" : "false";
    if (e.kind === "not") return this.single(e.expr, !when);
    if (e.kind === "test") return this.single(notZero(e.expr), when);
    if (e.kind === "var") return this.single(notZero({ kind: "var", id: e.id }), when);
    if ((e.kind === "and" && when) || (e.kind === "or" && !when)) {
      const parts = e.items.map((x) => this.single(x, when));
      if (parts.some((p) => p === null)) return null;
      if (parts.includes("false")) return "false";
      const conds = parts.filter((p): p is Cond[] => Array.isArray(p)).flat();
      return conds.length === 0 ? "true" : conds.length <= MOST_CONDS ? conds : null;
    }
    if (e.kind !== "compare") return null;
    if (e.unsigned === "left" || e.unsigned === "right") return this.single(plain(e), when);
    if (e.left.kind === "element") return this.cellConds(e, when);
    const sm = signedMask(e);
    if (sm) return this.single(sm, when);
    return this.conds(when ? e.op : INVERSE[e.op], side(e.left)!, side(e.right)!, e.unsigned === true);
  }

  /** The walk goes to `to` when `e` is `when`, and on otherwise. */
  jump(e: BoolExpr, when: boolean, to: string, at?: At): void {
    switch (e.kind) {
      case "const":
        if (e.value === when) this.goto(to);
        return;
      case "not": return this.jump(e.expr, !when, to, at);
      case "test": return this.jump(notZero(e.expr), when, to, at);
      case "var": return this.jump(notZero({ kind: "var", id: e.id }), when, to, at);
      case "and": case "or": {
        if ((e.kind === "and") !== when) {
          for (const x of e.items) this.jump(x, when, to, at);
          return;
        }
        // Every item must be so: one trigger when their conditions fit in one.
        const parts = e.items.map((x) => this.single(x, when));
        if (parts.every((p) => p !== null)) {
          if (parts.includes("false")) return;
          const conds = parts.filter((p): p is Cond[] => Array.isArray(p)).flat();
          if (conds.length === 0) return this.goto(to);
          if (conds.length <= MOST_CONDS) return this.branch(conds, to, at);
        }
        const past = this.label("p");
        for (let i = 0; i < e.items.length - 1; i++) this.jump(e.items[i], !when, past, at);
        this.jump(e.items[e.items.length - 1], when, to, at);
        this.land(past);
        return;
      }
      case "compare": {
        if (e.unsigned === "left" || e.unsigned === "right") return this.jump(plain(e), when, to, at);
        const sm = signedMask(e);
        if (sm) return this.jump(sm, when, to, at);
        const c = this.single(e, when);
        if (c === "false") return;
        if (c === "true") return this.goto(to);
        if (c) return this.branch(c, to, at);
        // != when true, == when false: below, or above — of the 32 bits as they are, which is the same.
        this.jump({ ...e, op: "<", unsigned: true }, true, to, at);
        this.jump({ ...e, op: ">", unsigned: true }, true, to, at);
        return;
      }
      default: throw new Error(`emitter: ${e.kind}`);
    }
  }

  // ── statements ──

  stmts(list: Stmt[]): void {
    for (const s of list) this.stmt(s);
  }

  stmt(s: Stmt): void {
    const outer = this.at;
    if (s.at) this.at = s.at;
    try {
      this.statement(s);
    } finally {
      this.at = outer;
    }
  }

  statement(s: Stmt): void {
    switch (s.kind) {
      case "remark": return;
      case "block": return this.stmts(s.body);
      case "declare": case "assign": case "if": case "while": case "for": case "do": case "assignBool": case "switch": case "store":
        if (this.scope.islands.has(s)) return this.left(s);
    }
    if (s.kind === "declare" && s.decl.kind === "boolean") return this.setBool(s.decl.id, s.init as BoolExpr);
    if (s.kind === "assignBool") return this.setBool(s.target, s.value);
    if (s.kind === "call" && !this.scope.islands.has(s)) return this.call(s.call);
    if (s.kind === "declareArray" && this.scope.native && !this.scope.islands.has(s)) return this.declareArray(s);
    if (s.kind === "return") return this.ret(s);
    const call = this.scope.calls.get(s);
    if (call && (s.kind === "declare" || s.kind === "assign") && call.fn.fn === "fdiv_by" && NATIVE.fdiv_by) {
      return this.reciprocal(call.fn.c!, call.args[0], s.kind === "declare" ? s.decl.id : s.target);
    }
    if (call && (s.kind === "declare" || s.kind === "assign")) {
      // The arguments into the function's parameters, written by the trigger before the call; the result into the
      // target's cell, copied into its other places after.
      const target = s.kind === "declare" ? s.decl.id : s.target;
      call.args.forEach((value, index) => {
        const id = `${this.key}.arg${this.n++}`;
        this.own.add(id);
        this.params.set(id, { param: call.fn, index });
        this.write(id, value, false);
      });
      this.results.add(target);
      this.open().items.push({ call: { fn: call.fn, target }, ...(this.at ? { at: this.at } : {}) }, { copy: target, ...(this.at ? { at: this.at } : {}) });
      return;
    }
    const store = this.scope.stores.get(s);
    if (store) return this.store(store);
    const cells = this.scope.tables.get(s);
    if (cells && (s.kind === "declare" || s.kind === "assign")) {
      const target = s.kind === "declare" ? s.decl.id : s.target;
      // (A map of our own: a value that is one cell of an array it keeps, read straight into the target.)
      const [only] = cells.reads;
      if (this.scope.native && cells.reads.length === 1 && only.table?.jump && cells.value.c === 0 && cells.value.terms.length === 1 && cells.value.terms[0].id === only.id && cells.value.terms[0].k === 1) {
        return this.readCell(target, only.table, s.at);
      }
      // (A product or a quotient alone, worked out straight into the target.)
      if (cells.reads.length === 1 && only.arith && cells.value.c === 0 && cells.value.terms.length === 1 && cells.value.terms[0].id === only.id && cells.value.terms[0].k === 1) {
        return this.arith(target, only.arith, new Map(), s.at);
      }
      // The cells first, each into a variable of the emitter's own; then the value, a sum of them and the rest.
      const own = new Map(cells.reads.map((r) => [r.id, `${this.key}.${r.id.slice(1)}`]));
      for (const r of cells.reads) {
        this.own.add(own.get(r.id)!);
        // (One a scratch cell is copied into — a product, a quotient, a cell jumped into — is heavy for what reads it.)
        if (r.arith || r.table?.jump) this.scope.heavy.add(own.get(r.id)!);
        if (r.table) this.readTable(own.get(r.id)!, r.table, s.at);
        else if (r.shift) this.readShift(own.get(r.id)!, r.shift, s.at);
        else this.arith(own.get(r.id)!, r.arith!, own, s.at);
      }
      const value = { c: cells.value.c, terms: cells.value.terms.map((t) => ({ id: own.get(t.id) ?? t.id, k: t.k })) };
      return this.write(target, value);
    }
    switch (s.kind) {
      case "declare": return this.write(s.decl.id, linear(s.init as NumExpr)!);
      case "assign": return this.write(s.target, linear(s.value)!);
      case "if": {
        const other = this.label("else"), done = this.label("fi");
        this.jump(s.cond, false, s.else?.length ? other : done, s.at);
        this.stmts(s.then);
        if (s.else?.length) {
          this.goto(done);
          this.land(other);
          this.stmts(s.else);
        }
        this.land(done);
        return;
      }
      case "while": case "for": {
        const head = this.label("loop"), cont = this.label("cont"), exit = this.label("exit");
        // What of the test nothing in the loop changes is tested once, on the way in (a u32 counter against a signed
        // bound is the bound's sign and the counter's place: the sign does not change).
        // (Everything the loop may write: a boolean set from a test, what a call in it writes, all the way down.)
        const { once, every } = s.cond ? split(s.cond, writes({ kind: "block", body: [...s.body, ...(s.kind === "for" ? s.update : [])], at: s.at }, this.scope.functions)) : { once: null, every: null };
        if (once) this.jump(once, false, exit, s.at);
        this.land(head);
        if (every) this.jump(every, false, exit, s.at);
        this.loops.push({ cont, exit });
        this.stmts(s.body);
        this.land(cont);
        if (s.kind === "for") this.stmts(s.update);
        this.loops.pop();
        this.goto(head);
        this.land(exit);
        return;
      }
      case "do": {
        const head = this.label("loop"), cont = this.label("cont"), exit = this.label("exit");
        this.land(head);
        this.loops.push({ cont, exit });
        this.stmts(s.body);
        this.loops.pop();
        this.land(cont);
        this.jump(s.cond, false, exit, s.at);
        this.goto(head);
        this.land(exit);
        return;
      }
      case "switch": {
        if (this.scope.islands.has(s)) return this.left(s);
        // A test of the value against each case, in order; the bodies one after another (a case falls into the next).
        const end = this.label("swend"), at = s.at;
        const labels = s.cases.map(() => this.label("case"));
        s.cases.forEach((c, i) => {
          if (c.value !== null) this.jump({ kind: "compare", op: "==", left: s.value, right: { kind: "const", value: c.value }, at, label: s.label }, true, labels[i], at);
        });
        const fallback = s.cases.findIndex((c) => c.value === null);
        this.goto(fallback >= 0 ? labels[fallback] : end);
        const outer = this.loops[this.loops.length - 1];
        this.loops.push({ cont: outer?.cont ?? end, exit: end });
        s.cases.forEach((c, i) => {
          this.land(labels[i]);
          this.stmts(c.body);
        });
        this.loops.pop();
        this.land(end);
        return;
      }
      case "unrolled": {
        if (this.scope.islands.has(s)) return this.left(s);
        // Each turn as it is: a continue goes to the next, a break past the last.
        const end = this.label("unend");
        for (const it of s.iterations) {
          const next = this.label("unnext");
          this.loops.push({ cont: next, exit: end });
          this.stmts(it);
          this.loops.pop();
          this.land(next);
        }
        this.land(end);
        return;
      }
      case "sleep": {
        if (!this.scope.native) return this.left(s);
        // A map of our own (layout.ts): the tick the program wakes at (the game's tick now, a bit at a time, plus the
        // frames) and where it goes on, written into the trigger that heads the owner's list every pass; then this
        // pass ends. Where it goes on puts that trigger back to ending the pass.
        const frames = s.cycles ?? Math.max(1, Math.round(((s.ms ?? 0) * FRAMES_PER_SECOND) / 1000));
        const resume = this.label("wake");
        this.open().items.push({ act: { dword: { data: WAKE_TICK }, modifier: "set", value: frames } }, { act: { dword: { data: WAKE_AT }, modifier: "set", value: { label: resume } } });
        for (let bit = 0; bit < 32; bit++) this.push({ conds: [{ dword: { game: GAME_TICK }, compare: "atLeast", value: 1, mask: 2 ** bit }], items: [{ act: { dword: { data: WAKE_TICK }, modifier: "add", value: 2 ** bit } }] });
        this.goto(END);
        this.push({ label: resume, conds: [], items: [{ act: { dword: { data: WAKE_NEXT }, modifier: "set", value: { label: END } } }] });
        return;
      }
      case "print":
        if (this.scope.native && !this.scope.islands.has(s)) {
          if (s.parts.every((p) => p.kind === "text")) this.open().items.push({ act: { dword: { game: 0 }, modifier: "set", value: 0, display: s.parts.map((p) => (p.kind === "text" ? p.text : "")).join("") } });
          else this.print(s);
          return;
        }
        return this.left(s);
      case "break": return this.goto(this.loops[this.loops.length - 1].exit);
      case "continue": return this.goto(this.loops[this.loops.length - 1].cont);
      default: return this.left(s);
    }
  }

  /**
   * A cell of a list known when the map is built, into `target`: the index into a variable of the emitter's own, the
   * target set to 0, and for each bit any of the values has, a trigger whose conditions are the index inside the list
   * (read from 0 up: one below zero is past the end, which reads 0) and that bit of the cell — read where it is, the
   * condition's player field the cell's EPD, a place of the index — adding the bit to every place of the target. The
   * index is tested first: the game stops at a trigger's first condition that fails, so a cell past the end is never
   * read. The Python side keeps a list of fewer than PACK_FROM values in an EUDVArray (a cell every 72 bytes, 18
   * EPD), a longer one as dwords one after another (`packed`).
   */
  readTable(target: string, t: Table, at?: At): void {
    if (t.jump && this.scope.native) return this.readCell(target, t, at);
    if (t.jump) return this.readJump(target, t, at);
    const stride = (t.array.values!.length >= PACK_FROM ? 1 : 18);
    this.arrays.set(t.array.id, stride);
    const index = `${this.key}.i${this.n++}`;
    this.own.add(index);
    this.write(index, t.index, false);
    this.write(target, { c: 0, terms: [] }, false);
    const bits = t.array.values!.reduce((m, v) => (m | (v >>> 0)) >>> 0, 0);
    const inside: Cond = { dword: this.home(index, 0), compare: "atMost", value: t.array.values!.length - 1 };
    for (let j = 0; j < 32; j++) {
      if (!((bits >>> j) & 1)) continue;
      const cell: Cond = { dword: { element: t.array.id }, compare: "atLeast", value: 1, mask: u(2 ** j) };
      this.condPlayers.set(cell, { id: index, scale: stride, add: 0, base: t.array.id });
      this.push({ conds: [{ ...inside }, cell], items: [{ bump: { target, add: u(2 ** j) } }], at });
    }
    this.open().items.push({ copy: target, ...(this.at ? { at: this.at } : {}) });
  }

  /**
   * A cell of an EUDVArray into `target`, by a jump into it: eudplib's getter (which every cell goes to, writing its
   * value into it) pointed at a scratch cell and back here; a trigger whose next pointer is a place of the index (the
   * address of the first cell, 72 bytes a cell) sends the walk into the cell; an index outside the array (read from 0
   * up) skips to a 0. The scratch cell is then copied into the target's places.
   */
  readJump(target: string, t: Table, at?: At): void {
    emitterCounts.jumps++;
    this.arrays.set(t.array.id, VARRAY_STRIDE_EPD);
    let index: string;
    if (t.index.c === 0 && t.index.terms.length === 1 && t.index.terms[0].k === 1) index = t.index.terms[0].id;
    else {
      index = `${this.key}.ji${this.n++}`;
      this.own.add(index);
      this.write(index, t.index, false);
    }
    const temp = `${this.key}.jt${this.n++}`, back = this.label("jback"), out = this.label("jout"), jump = this.label("jmp");
    this.open().items.push({ act: { dword: { getter: "dest" }, modifier: "set", value: { epd: { temp } } } }, { act: { dword: { getter: "next" }, modifier: "set", value: { label: back } } });
    this.jump({ kind: "compare", op: ">=", left: { kind: "var", id: index }, right: { kind: "const", value: t.array.length }, unsigned: true, at: at!, label: "" } as BoolExpr, true, out, at);
    this.push({ label: jump, conds: [], items: [], next: back, keep: true, at });
    this.jumpReads.set(jump, { id: index, scale: 72, add: 0, base: `addr:${t.array.id}` });
    this.land(out);
    this.push({ conds: [], items: [{ act: { dword: { temp }, modifier: "set", value: 0 } }], next: back, at });
    this.land(back);
    this.open().items.push({ fill: { temp, target } });
  }

  /**
   * A sum shifted right by a constant, into `target`: the sum into a variable of the emitter's own (or, a variable
   * alone, read in its cell), the target set to 0, and for each bit that comes down a trigger testing it and adding
   * its new place's worth to every place of the target — for `>>`, the sign bit its weight below zero. From the top,
   * eight bits a group, a group with none of its bits set is jumped over (a small number skips most), as the Python
   * side's shift does.
   */
  readShift(target: string, sh: Shift, at?: At): void {
    let home: Dword;
    if (sh.of.c === 0 && sh.of.terms.length === 1 && sh.of.terms[0].k === 1 && !this.own.has(sh.of.terms[0].id)) home = this.placesOf(sh.of.terms[0].id)[0].dword!;
    else {
      const of = `${this.key}.s${this.n++}`;
      this.own.add(of);
      this.write(of, sh.of, false);
      home = this.home(of, 0);
    }
    this.write(target, { c: 0, terms: [] }, false);
    const highest = sh.top === undefined ? 31 : Math.min(31, Math.max(0, sh.top).toString(2).length - 1);
    if (highest < sh.by) {
      // (Every bit that would come down is 0.)
      this.open().items.push({ copy: target, ...(this.at ? { at: this.at } : {}) });
      return;
    }
    for (let top = highest; top >= sh.by; top -= 8) {
      const bits = [];
      for (let j = top; j >= Math.max(sh.by, top - 7); j--) bits.push(j);
      const group = bits.reduce((m, j) => (m + 2 ** j), 0);
      const past = this.label("g");
      this.branch([{ dword: home, compare: "exactly", value: 0, mask: u(group) }], past, at);
      for (const j of bits) {
        const add = j === 31 && sh.signed ? u(-(2 ** (31 - sh.by))) : u(2 ** (j - sh.by));
        this.push({ conds: [{ dword: home, compare: "atLeast", value: 1, mask: u(2 ** j) }], items: [{ bump: { target, add } }], at });
      }
      this.land(past);
    }
    this.open().items.push({ copy: target });
  }

  /** A boolean set from a test: 1 when it holds, 0 when not. */
  setBool(target: string, cond: BoolExpr): void {
    const no = this.label("bno"), done = this.label("bdone");
    this.jump(cond, false, no, this.at);
    this.write(target, { c: 1, terms: [] });
    this.goto(done);
    this.land(no);
    this.write(target, { c: 0, terms: [] });
    this.land(done);
  }

  /**
   * A call (a map of our own). The arguments are written into the function's parameters — into every place each has
   * in the function's triggers, as any write is — in order; the rewriter has already taken into variables of its own
   * any value a later argument's call could change. A called function: the trigger with the arguments also sets the
   * next pointer of the trigger the function ends at to here, and goes to the function's first; back here, the
   * function's result is copied into the call's own. An inlined call: its body where it stands, its result 0 until a
   * `return` writes it (as the Python side has it).
   */
  call(c: Call): void {
    if (!c.saves) this.arguments(c);
    if (c.fn !== undefined) {
      const f = this.scope.functions.get(c.fn)!;
      let fn = this.fns.get(c.fn);
      if (!fn) {
        this.fns.set(c.fn, (fn = { entry: this.label("fn"), exit: this.label("fx"), depth: 0 }));
        this.pending.push(c.fn);
      }
      fn.depth = Math.max(fn.depth, this.depthBase + this.loops.length);
      const back = this.label("back");
      // (A function that calls itself also keeps where it goes back to in a variable, which a frame keeps: the frame
      // of a call that may come back is the function's the call is in.)
      const ra = f.recursive ? this.returnOf(c.fn, fn.exit) : null;
      const within = c.saves && this.current !== undefined ? this.fns.get(this.current) : undefined;
      if (c.saves && !within) throw new Error(`emitter: a call of ${f.name} that keeps a frame, outside a function`);
      const kept = c.saves ? this.keep(c, this.returnOf(this.current!, within!.exit)) : null;
      if (kept) this.arguments(c);
      this.open().items.push(ra ? { label: { target: ra, to: back } } : { act: { dword: nextOf(fn.exit), modifier: "set", value: { label: back } } });
      this.goto(fn.entry);
      this.land(back);
      if (kept) this.bringBack(kept);
      if (c.result && f.result) {
        // What the function gives back goes into its cell alone, and each call reads it from there: as places, a
        // return would write every call's, and each of those actions would be a place of what the return reads —
        // the parameters, then what every call passes them — so places would multiply from call to call.
        this.results.add(f.result.decl.id);
        this.write(c.result.decl.id, { c: 0, terms: [{ id: f.result.decl.id, k: 1 }] });
      }
      return;
    }
    const end = this.label("iend");
    if (c.result) this.write(c.result.decl.id, { c: 0, terms: [] });
    this.frames.push({ ...(c.result ? { result: { id: c.result.decl.id, kind: c.result.kind } } : {}), end });
    this.stmts(c.body);
    this.frames.pop();
    this.land(end);
  }

  /**
   * The arguments into the parameters, in order. A call that may come back into the function it is in sets that
   * function's own parameters, which a later argument may read: then every argument goes into a variable of the
   * emitter's own first.
   */
  arguments(c: Call): void {
    const set = (id: string, kind: string, value: NumExpr | BoolExpr) => (kind === "boolean" ? this.setBool(id, value as BoolExpr) : this.write(id, linear(value as NumExpr)!));
    const params = new Set(c.params.map((p) => p.decl.id));
    const crossed = c.params.some((p, i) => i > 0 && [...readIn(p.init as NumExpr | BoolExpr)].some((id) => params.has(id) && c.params.findIndex((q) => q.decl.id === id) < i));
    if (!crossed) {
      for (const p of c.params) set(p.decl.id, p.decl.kind, p.init as NumExpr | BoolExpr);
      return;
    }
    const temps = c.params.map((p) => {
      const t = `${this.key}.arg${this.n++}`;
      this.own.add(t);
      set(t, p.decl.kind, p.init as NumExpr | BoolExpr);
      return t;
    });
    c.params.forEach((p, i) => this.write(p.decl.id, { c: 0, terms: [{ id: temps[i], k: 1 }] }));
  }

  /**
   * Where a function that calls itself goes back to, as a variable whose places are the next pointer of the trigger
   * the function ends at and the number of each store that keeps it on the stack: every call of the function sets
   * them all to where it goes on (a label), and after a call that may come back a cell of the stack puts them back.
   */
  returnOf(fn: string, exit: string): string {
    const ra = `${fn}.(goes back to)`;
    if (!this.places.has(ra)) this.placesOf(ra).push({ dword: nextOf(exit), scale: 1, add: 0 });
    return ra;
  }

  /**
   * Before a call that may come back into the function it is in (a map of our own): too deep, the program says so and
   * stops for good, as the Python side's build does; otherwise the function's variables and where it goes back to
   * onto the stack — one trigger, a Set Deaths each, its destination a place of `sp`, its number a place of what it
   * keeps — and `sp` and `depth` on.
   */
  keep(c: Call, ra: string): { vars: string[]; stack: { id: string; sp: string } } {
    // (Only what is read again before it is written: `saves` lists every variable of the function.)
    const live = this.live.get(c);
    if (!live) throw new Error(`emitter: a call of ${c.name ?? "a function"} that keeps a frame, not looked at`);
    const vars = [...c.saves!.vars.filter((id) => live.has(id)), ra];
    const stack = this.stackOf(this.current!);
    stack.frame = Math.max(stack.frame, vars.length);
    this.own.add(this.depth);
    const room = this.label("room");
    this.jump({ kind: "compare", op: "<", left: { kind: "var", id: this.depth }, right: { kind: "const", value: this.stackDepth }, unsigned: true, at: this.at!, label: "" }, true, room, this.at);
    const line = this.at?.line ?? "?";
    this.open().items.push(
      { act: { dword: { game: 0 }, modifier: "set", value: 0, display: `\x06TrigScript: stack overflow in ${c.saves!.within}, line ${line} - ${this.stackDepth} calls deep. The program has stopped.` } },
      { act: { dword: { data: WAKE_TICK }, modifier: "set", value: U32 - 1 } },
    );
    this.goto(END);
    this.land(room);
    // (Each variable through one of the emitter's own, written just before: a store's number is a place no refresh
    // reaches, and the variable itself may have to be read from its cell where it is used.)
    const kept = vars.map((id) => (id === ra ? id : this.pin({ c: 0, terms: [{ id, k: 1 }] }, "kv")));
    const store = this.push({ conds: [], items: [] });
    kept.forEach((id, j) => {
      const act: Act = { dword: { element: stack.id }, modifier: "set", value: 0 };
      this.actPlaces.set(act, { dest: { id: stack.sp, scale: 18, add: 18 * j, base: stack.id }, value: { id, scale: 1, add: 0 } });
      store.items.push({ act });
    });
    // (A trigger of its own after it: an action's place is its index in its trigger, which the writes of `sp` would
    // push past 64.)
    this.push({ conds: [], items: [] });
    this.write(stack.sp, { c: vars.length, terms: [{ id: stack.sp, k: 1 }] }, false);
    this.write(this.depth, { c: 1, terms: [{ id: this.depth, k: 1 }] }, false);
    return { vars, stack };
  }

  /**
   * After it: `sp` and `depth` back, and each cell of the frame into a scratch cell — a trigger that sets the scratch
   * cell to 0, points the stack cell's action at it and its next pointer back here, and goes to it (its own next
   * pointer a place of `sp`) — and the scratch cell into every place of the variable.
   */
  bringBack(kept: { vars: string[]; stack: { id: string; sp: string } }): void {
    const { id: stack, sp } = kept.stack;
    this.write(sp, { c: u(-kept.vars.length), terms: [{ id: sp, k: 1 }] }, false);
    this.write(this.depth, { c: MAX, terms: [{ id: this.depth, k: 1 }] }, false);
    kept.vars.forEach((id, j) => {
      const temp = `${this.key}.st${this.n++}`, after = this.label("got"), jump = this.label("pop");
      const point: Act = { dword: { element: stack }, modifier: "set", value: { epd: { temp } } };
      const back: Act = { dword: { element: stack }, modifier: "set", value: { label: after } };
      this.actPlaces.set(point, { dest: { id: sp, scale: 18, add: 18 * j - 1, base: stack } });
      this.actPlaces.set(back, { dest: { id: sp, scale: 18, add: 18 * j - 86, base: stack } });
      this.push({ label: jump, conds: [], items: [{ act: { dword: { temp }, modifier: "set", value: 0 } }, { act: point }, { act: back }], next: after, keep: true });
      this.jumpReads.set(jump, { id: sp, scale: 72, add: 72 * j, base: `addr:${stack}` });
      this.land(after);
      this.open().items.push({ fill: { temp, target: id } });
    });
  }

  /**
   * The routine that writes a number as digits (a map of our own), called by each print with a number in it: where
   * its two ways in are (a signed number, a `u32`), the trigger it ends at (its next pointer the call's), the variable
   * the number is handed in, and the three dwords it writes the digits into — 12 bytes, the number at their right end,
   * 0x0D (which draws nothing) before it — which the print then copies into its text.
   */
  itoa?: { signed: string; unsigned: string; exit: string; v: string; r: string; neg: string; out: string[] };
  /** The printed texts' templates (`Graph.templates`). */
  templates: { id: string; bytes: number[] }[] = [];

  /**
   * A text printed with values in it (a map of our own). Its template is laid out when the map is built: the text,
   * and for each number a field of 12 bytes on a dword's start, the bytes before it to the dword's start 0x0D (they draw
   * nothing); for each byte from a number (a colour code), one byte. Nothing in the text moves, however wide the number
   * is: the routine writes the number at the right end of its field, 0x0D before it. A print hands each number to the
   * routine, copies its three dwords into the field, writes each byte where it goes (0x0D for a 0, which writes
   * nothing), and shows the template with Display Text. (The rewriter has already put the values in the order
   * JavaScript works them out.)
   */
  print(s: Extract<Stmt, { kind: "print" }>): void {
    const id = `${this.key}.text${this.n++}`;
    const bytes: number[] = [];
    const enc = new TextEncoder();
    const values: { part: TextPart; at: number }[] = [];
    for (const p of s.parts) {
      if (p.kind === "text") bytes.push(...enc.encode(p.text));
      else if (p.kind === "number") {
        while (bytes.length % 4) bytes.push(PAD);
        values.push({ part: p, at: bytes.length });
        bytes.push(...Array(12).fill(PAD));
      } else if (p.kind === "char") {
        values.push({ part: p, at: bytes.length });
        bytes.push(PAD);
      }
    }
    bytes.push(0);
    this.templates.push({ id, bytes });
    for (const { part, at } of values) {
      if (part.kind === "number") {
        const it = this.digits();
        this.write(it.v, linear(part.expr)!, false);
        const back = this.label("printed");
        this.open().items.push({ act: { dword: nextOf(it.exit), modifier: "set", value: { label: back } } });
        this.goto(part.unsigned ? it.unsigned : it.signed);
        this.land(back);
        it.out.forEach((from, w) => this.open().items.push({ route: { from, into: [{ template: id, word: at / 4 + w }] } }));
        continue;
      }
      if (part.kind !== "char") continue;
      // The byte: the number's low eight bits into its place in the dword (a mask), a place of the number; 0x0D when
      // they are 0.
      const word: Dword = { template: id, word: at >> 2 }, shift = 2 ** (8 * (at & 3)), mask = u(0xff * shift);
      const from = this.alone(linear(part.expr)!, "ch");
      const set: Act = { dword: word, modifier: "set", value: 0, mask };
      this.actPlaces.set(set, { value: { id: from, scale: shift, add: 0 } });
      this.push({ conds: [], items: [{ act: set }] });
      this.push({ conds: [{ dword: word, compare: "exactly", value: 0, mask }], items: [{ act: { dword: word, modifier: "set", value: u(PAD * shift), mask } }] });
    }
    this.open().items.push({ act: { dword: { game: 0 }, modifier: "set", value: 0, show: id } });
  }

  /** The routine that writes a number as digits: its labels and variables, made the first time a print needs it. */
  digits(): NonNullable<Emitter["itoa"]> {
    if (!this.itoa) {
      const v = (name: string) => `${this.key}.(digits ${name})`;
      this.itoa = { signed: this.label("itoa"), unsigned: this.label("itoau"), exit: this.label("itoax"), v: v("of"), r: v("left"), neg: v("minus"), out: [v("0"), v("1"), v("2")] };
      this.own.add(this.itoa.r);
      this.own.add(this.itoa.neg);
    }
    return this.itoa;
  }

  /**
   * The routine, laid out once after the program and its functions. The three dwords set to 0x0D all through; the
   * number's size into `left` (a signed one's sign apart); how many digits it has, by comparisons with powers of ten
   * (four at most); then, from that many digits down, each digit's '0' (its byte from 0x0D up to 0x30, all in the
   * trigger the comparisons go to, with the minus sign before the first digit when there is one) and its value: a
   * trigger each for 8, 4, 2 and 1 times the digit's power of ten, which takes it from `left` and adds it to the
   * digit's byte when `left` holds that much. About four triggers a digit; eudplib's build divides by ten for each.
   */
  emitDigits(): void {
    const it = this.itoa;
    if (!it) return;
    const set = (id: string, c: number, terms: { id: string; k: number }[] = []) => this.write(id, { c: u(c), terms }, false);
    this.land(it.signed);
    set(it.neg, 0);
    set(it.r, 0, [{ id: it.v, k: 1 }]);
    const go = this.label("itoago");
    this.jump({ kind: "compare", op: "<", left: { kind: "var", id: it.v }, right: { kind: "const", value: 0 }, at: this.at!, label: "" } as BoolExpr, false, go);
    set(it.r, 0, [{ id: it.v, k: MAX }]);
    set(it.neg, 1);
    this.goto(go);
    this.land(it.unsigned);
    set(it.neg, 0);
    set(it.r, 0, [{ id: it.v, k: 1 }]);
    this.land(go);
    for (const w of it.out) set(w, PAD * 0x01010101);
    // How many digits: k when `left` is at least 10^(k-1).
    const width = Array.from({ length: 11 }, (_, k) => this.label(`itoak${k}`));
    const tree = (lo: number, hi: number): void => {
      if (lo === hi) return this.goto(width[lo]);
      const mid = (lo + hi + 1) >> 1, high = this.label("itoahi");
      this.jump({ kind: "compare", op: ">=", left: { kind: "var", id: it.r }, right: { kind: "const", value: 10 ** (mid - 1) }, unsigned: true, at: this.at!, label: "" } as BoolExpr, true, high);
      tree(lo, mid - 1);
      this.land(high);
      tree(mid, hi);
    };
    tree(1, 10);
    // The byte of digit p (of 10^p) is 11 - p: the dword (11 - p) >> 2, its byte (11 - p) & 3.
    const at = (b: number) => ({ word: b >> 2, shift: 2 ** (8 * (b & 3)) });
    const ladder = Array.from({ length: 10 }, (_, p) => this.label(`itoap${p}`));
    for (let k = 10; k >= 1; k--) {
      this.land(width[k]);
      const zeros = [0, 0, 0];
      for (let p = 0; p < k; p++) zeros[at(11 - p).word] += (0x30 - PAD) * at(11 - p).shift;
      zeros.forEach((add, w) => { if (add) this.open().items.push({ bump: { target: it.out[w], add: u(add) } }); });
      const sign = at(11 - k);
      this.push({ conds: [{ dword: this.home(it.neg, 0), compare: "atLeast", value: 1 }], items: [{ bump: { target: it.out[sign.word], add: u((0x2d - PAD) * sign.shift) } }] });
      this.goto(ladder[k - 1]);
    }
    for (let p = 9; p >= 0; p--) {
      this.land(ladder[p]);
      const { word, shift } = at(11 - p);
      for (const m of [8, 4, 2, 1]) {
        const step = m * 10 ** p;
        if (step >= U32) continue;
        this.push({ conds: [{ dword: this.home(it.r, 0), compare: "atLeast", value: step }], items: [{ bump: { target: it.r, add: u(-step) } }, { bump: { target: it.out[word], add: m * shift } }] });
      }
    }
    this.push({ label: it.exit, conds: [], items: [], keep: true });
  }

  /** A `return`: the value into the result of the function or inlined call around it, and on to its end. */
  ret(s: Extract<Stmt, { kind: "return" }>): void {
    const frame = this.frames[this.frames.length - 1];
    const r = frame.result;
    if (r && r.kind === "boolean" && s.value !== undefined) this.setBool(r.id, s.value as BoolExpr);
    else if (r) this.write(r.id, s.value === undefined ? { c: 0, terms: [] } : linear(s.value as NumExpr)!);
    this.goto(frame.end);
  }

  /**
   * The functions the calls reached, each laid out once after the program (which never falls into them): its body,
   * what it gives back off its end (0), and the trigger it ends at — empty, kept, its next pointer the call's. A
   * function called inside loops counts its triggers as that deep, for what weighs a variable's reads.
   */
  functions(): void {
    for (let id = this.pending.shift(); id !== undefined; id = this.pending.shift()) {
      const f = this.scope.functions.get(id)!, body = this.scope.bodyOf!(id)!, fn = this.fns.get(id)!;
      const outer = this.depthBase;
      this.depthBase = fn.depth;
      this.current = id;
      this.live = f.recursive ? liveAfterCalls(body) : new Map();
      this.land(fn.entry);
      const result = f.result ? { id: f.result.decl.id, kind: f.result.kind } : undefined;
      this.frames.push({ ...(result ? { result } : {}), end: fn.exit });
      this.stmts(body);
      this.frames.pop();
      const last = body.filter((s) => s.kind !== "remark").at(-1);
      if (result && last?.kind !== "return") this.write(result.id, { c: 0, terms: [] });
      this.push({ label: fn.exit, conds: [], items: [], keep: true, at: f.at });
      this.depthBase = outer;
    }
  }

  /**
   * `c / x` of a fixed number x and a constant c above zero, as the emitter's own triggers — the very bits of the Python
   * side's `make_const_fdiv` (part 3): long division the way it is done on paper, the remainder doubled a step and the
   * divisor taken away when it fits. Where that function copies the divisor into its loop, here the divisor's magnitude
   * is a variable whose places are the loop's comparison and subtraction (the latter its negation: the game's subtract
   * stops at 0), written by the graph where it computes it. The quotient, the remainder and the dividend's bits still to
   * come are cells of the graph's own (`cells`: one trigger whose actions add their numbers to themselves). The search
   * of the divisor's top bit (a branch a level) leaves the remainder and the quotient's top bit — which reaches bit 31 on
   * the last step, the loop's test of its end — as constants. The quotient then goes into the target's cell by the
   * quotient's own action, pointed at the number of the action that sets the target and run once: its sign after, the
   * negative one as 0xFFFFFFFF less it (a subtract that never reaches 0) plus 0x80000001. A divisor whose quotient
   * takes 32 bits or more (a few 65 536ths) is the Python side's function's.
   */
  reciprocal(c: number, x: Linear, target: string): void {
    const d = BigInt(c) << 16n;
    const topD = d.toString(2).length - 1;
    type Plan = "zero" | null | { n: number; r0: number; rest: number };
    const plan = (t: number): Plan => {
      const n = topD - t + 1;
      if (n <= 0) return "zero";
      if (n > 31) return null;
      return { n, r0: Number(d >> BigInt(n)), rest: Number(((d & ((1n << BigInt(n)) - 1n)) << BigInt(32 - n)) & 0xffffffffn) };
    };
    const plans = Array.from({ length: 32 }, (_, t) => plan(t));
    emitterCounts.reciprocals++;
    const withBits = plans.some((p) => p && p !== "zero" && p.rest);
    this.results.add(target);
    // The magnitude and the sign.
    const b = `${this.key}.rb${this.n++}`, neg = `${this.key}.rn${this.n++}`;
    this.own.add(b);
    this.own.add(neg);
    // (A sum the sign of which is tested: into a variable of the emitter's own first, unless it is one plus a constant.)
    if (!(x.terms.length === 1 && x.terms[0].k === 1)) {
      const xs = `${this.key}.rx${this.n++}`;
      this.own.add(xs);
      this.write(xs, x, false);
      x = { c: 0, terms: [{ id: xs, k: 1 }] };
    }
    const xv: NumExpr = linearExpr(x);
    const done = this.label("rdone"), zero = this.label("rzero"), slow = this.label("rslow"), loop = this.label("rloop");
    this.write(neg, { c: 0, terms: [] }, false);
    const positive = this.label("rpos"), signed = this.label("rsigned");
    this.jump({ kind: "compare", op: "<", left: xv, right: { kind: "const", value: 0 }, at: this.at!, label: "" } as BoolExpr, false, positive, this.at);
    this.write(b, scaled(x, MAX), false);
    this.write(neg, { c: 1, terms: [] }, false);
    this.goto(signed);
    this.land(positive);
    this.write(b, x, false);
    this.land(signed);
    const bv: NumExpr = { kind: "var", id: b };
    this.jump({ kind: "compare", op: "==", left: bv, right: { kind: "const", value: 0 }, unsigned: true, at: this.at!, label: "" } as BoolExpr, true, zero, this.at);
    // The cells, and the loop's triggers (made below, after the search, which goes to them).
    const cells = this.label("rcells"), takeBit = this.label("rbit"), test = this.label("rtest");
    const field = (k: number): Dword => ({ at: cells, field: { act: k, part: "value" } });
    const q = field(0), r = field(1), bits = field(2);
    // The cells back to doubling themselves (a call before routed the quotient's elsewhere), going on to the loop.
    const restore: Act[] = [0, 1, ...(withBits ? [2] : [])].flatMap((k) => [
      { dword: { at: cells, field: { act: k, part: "dest" } }, modifier: "set", value: { epd: field(k) } } as Act,
      { dword: { at: cells, field: { act: k, part: "modifier" } }, modifier: "set", value: 8 * 2 ** 24, mask: 0xff000000 } as Act,
    ]);
    this.open().items.push(...restore.map((act) => ({ act })), { act: { dword: { at: cells, field: "next" }, modifier: "set", value: { label: withBits ? takeBit : test } } });
    // The search of the divisor's top bit: a leaf sets the cells for its plan, or goes where the plan says.
    const leaf = (t: number) => {
      const p = plans[t];
      if (p === "zero") return this.goto(zero);
      if (p === null) return this.goto(slow);
      const acts: Act[] = [{ dword: r, modifier: "set", value: p.r0 }, { dword: q, modifier: "set", value: 2 ** (31 - p.n) }];
      if (withBits) acts.push({ dword: bits, modifier: "set", value: Math.floor(p.rest / 2) });
      this.push({ conds: [], items: acts.map((act) => ({ act })), next: loop });
    };
    const tree = (lo: number, hi: number) => {
      if (lo === hi) return leaf(lo);
      const mid = (lo + hi + 1) >> 1, high = this.label("rhi");
      this.jump({ kind: "compare", op: ">=", left: bv, right: { kind: "const", value: 2 ** mid }, unsigned: true, at: this.at!, label: "" } as BoolExpr, true, high, this.at);
      tree(lo, mid - 1);
      this.land(high);
      tree(mid, hi);
    };
    tree(0, 31);
    // The loop: the cells doubled, the dividend's next bit into the remainder, the divisor taken away when it fits.
    this.land(loop);
    this.push({ label: cells, conds: [], items: [q, r, ...(withBits ? [bits] : [])].map((f) => ({ act: { dword: f, modifier: "add", value: 0 } as Act })), next: withBits ? takeBit : test });
    if (withBits) this.push({ label: takeBit, conds: [{ dword: bits, compare: "atLeast", value: SIGN }], items: [{ act: { dword: r, modifier: "add", value: 1 } }], next: test });
    const fits: Cond = { dword: r, compare: "atLeast", value: 0 };
    this.condReads.set(fits, { id: b, scale: 1, add: 0 });
    const takeAway: Act = { dword: r, modifier: "add", value: 0 };
    this.actPlaces.set(takeAway, { value: { id: b, scale: MAX, add: 0 } });
    this.push({ label: test, conds: [fits], items: [{ act: takeAway }, { act: { dword: q, modifier: "add", value: 1 } }] });
    // The end: the quotient's top bit at bit 31.
    const leave = this.label("rleave");
    this.branch([{ dword: q, compare: "atLeast", value: SIGN }], leave, this.at);
    this.goto(cells);
    // The quotient into the target's cell, by its own action: set, then its top bit taken off; or its negation.
    this.land(leave);
    const into = this.placesOf(target)[0].dword!;
    const negLeave = this.label("rnegl");
    this.jump({ kind: "compare", op: "==", left: { kind: "var", id: neg }, right: { kind: "const", value: 0 }, unsigned: true, at: this.at!, label: "" } as BoolExpr, false, negLeave, this.at);
    const route = (setAt: string, k: number, back: string): Act[] => [
      { dword: { at: cells, field: { act: 0, part: "dest" } }, modifier: "set", value: { epd: { at: setAt, field: { act: k, part: "value" } } } },
      { dword: { at: cells, field: { act: 0, part: "modifier" } }, modifier: "set", value: 7 * 2 ** 24, mask: 0xff000000 },
      { dword: { at: cells, field: "next" }, modifier: "set", value: { label: back } },
    ];
    const setPos = this.label("rsetp"), setNeg = this.label("rsetn");
    this.push({ conds: [], items: route(setPos, 0, setPos).map((act) => ({ act })), next: cells });
    this.land(negLeave);
    this.push({ conds: [], items: route(setNeg, 1, setNeg).map((act) => ({ act })), next: cells });
    this.push({ label: setPos, conds: [], items: [{ act: { dword: into, modifier: "set", value: 0 } }, { act: { dword: into, modifier: "add", value: SIGN } }], next: done });
    this.push({ label: setNeg, conds: [], items: [{ act: { dword: into, modifier: "set", value: MAX } }, { act: { dword: into, modifier: "subtract", value: 0 } }, { act: { dword: into, modifier: "add", value: SIGN + 1 } }], next: done });
    // A quotient of 0; a divisor of a few 65 536ths, the Python side's function.
    this.land(zero);
    this.push({ conds: [], items: [{ act: { dword: into, modifier: "set", value: 0 } }], next: done });
    this.land(slow);
    {
      const id = `${this.key}.arg${this.n++}`;
      const fn: FixedFn = { fn: "fdiv_by", c };
      this.own.add(id);
      this.params.set(id, { param: fn, index: 0 });
      this.write(id, x, false);
      this.open().items.push({ call: { fn, target } });
    }
    this.land(done);
    this.open().items.push({ copy: target });
  }

  // ── products and quotients (step 4 of the way off eudplib) ──

  /**
   * A product, a quotient or a remainder (`Arith`) into `target`; the variables of the emitter's own its sides read are
   * named in `own` (the reads before it).
   */
  arith(target: string, x: Arith, own: Map<string, string>, at?: At): void {
    const rename = (l: Linear): Linear => ({ c: l.c, terms: l.terms.map((t) => ({ id: own.get(t.id) ?? t.id, k: t.k })) });
    const a = rename(x.a), b = rename(x.b);
    this.top = x.r && x.r[0] >= 0 ? x.r[1] : undefined;
    if (this.top !== undefined && this.own.has(target)) this.tops.set(target, this.top);
    // (The target read while its scratch cells are worked in — `x = x * y` — keeps them apart.)
    const apart = [...a.terms, ...b.terms].some((t) => t.id === target);
    if (x.op === "*") return this.product(target, a, b, x.ra, x.rb, apart, at);
    if (b.terms.length === 0) return this.divideByConst(target, x.op, a, b.c, x.unsigned, x.ra, apart, at);
    return this.divide(target, x.op, a, b, x.unsigned, x.ra, x.rb, apart, at);
  }

  /** A sum as a variable times a constant plus a constant, for a field to hold a multiple of: one of the emitter's own when it has more than one variable. */
  multiple(l: Linear, name: string): Multiple {
    if (l.terms.length === 1) return { id: l.terms[0].id, k: l.terms[0].k, c: l.c };
    return { id: this.alone(l, name), k: 1, c: 0 };
  }

  /**
   * An action setting, adding or taking away `by` times `m` at a dword: its number a place of m's variable, kept by its
   * writes — or, for a variable the plan copies (`Scope.heavy`), whose copies would fill such a place at every write,
   * its cell routed into the number as the routine starts (`fed`, `routeFed`: 56 ns once a use).
   */
  times(dword: Dword, m: Multiple, by: number, modifier: "set" | "add" | "subtract" = "add"): Act {
    const act: Act = { dword, modifier, value: 0 };
    if (this.scope.heavy.has(m.id) && mul(m.k, by) === 1) this.fed.set(act, { id: m.id, add: mul(m.c, by) });
    else this.actPlaces.set(act, { value: { id: m.id, scale: mul(m.k, by), add: mul(m.c, by) } });
    return act;
  }

  /** A condition comparing a dword with `m`, its number read as `times` reads one. */
  against(dword: Dword, compare: Compare, m: Multiple): Cond {
    const cond: Cond = { dword, compare, value: 0 };
    if (this.scope.heavy.has(m.id) && m.k === 1) this.fed.set(cond, { id: m.id, add: m.c });
    else this.condReads.set(cond, { id: m.id, scale: m.k, add: m.c });
    return cond;
  }

  /**
   * The most each variable of the emitter's own a product or a quotient fills can be, when value ranges know it never
   * below zero: a copy of it into a field holding a multiple goes over only those bits (`product`'s narrow sides).
   */
  tops = new Map<string, number>();
  /** The most the answer of the product or the quotient being laid out can be, when never below zero: its fill's copy's. */
  top?: number;

  /** The actions' and conditions' numbers a routine reads a heavy variable by, to route its cell into (`routeFed`). */
  fed = new Map<Act | Cond, { id: string; add: number }>();
  /** Dwords a routine sets to a heavy variable as it starts (`setTo`): its cell routed into each. */
  fedDwords: { id: string; add: number; dword: Dword }[] = [];

  /** A dword set to `m` as the routine starts: its variable's cell routed there (a heavy one, `fed`), or set from a place of it. */
  setTo(dword: Dword, m: Multiple, at?: At): void {
    if (this.scope.heavy.has(m.id) && m.k === 1) this.fedDwords.push({ id: m.id, add: m.c, dword });
    else this.push({ conds: [], items: [{ act: this.times(dword, m, 1, "set") }], at });
  }

  /**
   * A routine's start: an empty trigger, where `routeFed` puts the routes into the fields its triggers made after it
   * read heavy variables by. Returns its index among the triggers.
   */
  beginFed(at?: At): number {
    this.push({ conds: [], items: [], at });
    return this.protos.length - 1;
  }
  routeFed(from: number): void {
    const into = new Map<string, Dword[]>(), adds: Act[] = [];
    const take = (x: Act | Cond, field: Dword) => {
      const f = this.fed.get(x);
      if (!f) return;
      into.set(f.id, [...(into.get(f.id) ?? []), field]);
      if (f.add) adds.push({ dword: field, modifier: "add", value: f.add });
      this.fed.delete(x);
    };
    for (const p of this.protos.slice(from + 1)) {
      p.conds.forEach((c, k) => take(c, { at: p.label, field: { cond: k } }));
      let k = 0;
      for (const it of p.items) if ("act" in it) take(it.act, { at: p.label, field: { act: k++, part: "value" } });
    }
    for (const f of this.fedDwords.splice(0)) {
      into.set(f.id, [...(into.get(f.id) ?? []), f.dword]);
      if (f.add) adds.push({ dword: f.dword, modifier: "add", value: f.add });
    }
    this.protos[from].items.unshift(...[...into].map(([id, dwords]) => ({ route: { from: id, into: dwords } }) as Item), ...adds.map((act) => ({ act }) as Item));
  }

  /**
   * The doubling trigger of a product or a quotient: each of `cells` — its own actions' numbers, in order — added to
   * itself (an action whose number is its own destination), and its next pointer moved on a trigger, so that each time
   * it runs it goes to the step after the one it went to before: the steps are a run of triggers laid out one after
   * another, and no trigger before each says where to go.
   */
  doubler(R: string, cells: Dword[], first: string, at?: At): void {
    this.push({ label: R, conds: [], items: [...cells.map((d) => ({ act: { dword: d, modifier: "add", value: 0 } as Act })), { act: { dword: nextOf(R), modifier: "add", value: TRIGGER_BYTES } }], next: first, keep: true, at });
  }

  /**
   * Into a run of `n` steps (a doubling trigger's) at the first that matters: the doubling trigger pointed at it — it
   * moves itself on from there — and the walk sent there. From the top, a group of eight steps whose bits are all clear
   * (`atLeast(k)` the condition that the number tested has a bit at k or above) is jumped over.
   */
  enter(n: number, step: (i: number) => string, R: string, atLeast: (k: number) => Cond, at?: At): void {
    const entries: [string, number][] = [];
    let g = 0;
    for (; g + 8 < n; g += 8) {
      const e = this.label("he");
      this.branch([atLeast(n - 8 - g)], e, at);
      entries.push([e, g]);
    }
    const last = this.label("he");
    this.goto(last);
    entries.push([last, g]);
    for (const [label, i] of entries) this.push({ label, conds: [], items: [{ act: { dword: nextOf(R), modifier: "set", value: { label: step(i) } } }], next: step(i), at });
  }

  /**
   * What the doubling trigger's actions hold, out into scratch cells: each action pointed at its cell, set to 0 first —
   * or, when `negative` holds, to MAX with the action made a subtraction and 1 added after: the negation — the move of
   * its next pointer pointed at a cell of no use, the trigger run once more, and all pointed back.
   */
  takeOut(R: string, advance: number, outs: { act: number; temp: string }[], negative: Cond[] | null, at?: At): void {
    const field = (act: number, part: "value" | "dest" | "modifier"): Dword => ({ at: R, field: { act, part } });
    const run = (minus: boolean) => {
      const back = this.label("tb"), pre: Act[] = [], post: Act[] = [];
      for (const o of outs) {
        pre.push({ dword: { temp: o.temp }, modifier: "set", value: minus ? MAX : 0 }, { dword: field(o.act, "dest"), modifier: "set", value: { epd: { temp: o.temp } } });
        post.push({ dword: field(o.act, "dest"), modifier: "set", value: { epd: field(o.act, "value") } });
        if (minus) {
          pre.push({ dword: field(o.act, "modifier"), modifier: "set", value: 9 * 2 ** 24, mask: 0xff000000 });
          post.push({ dword: field(o.act, "modifier"), modifier: "set", value: 8 * 2 ** 24, mask: 0xff000000 }, { dword: { temp: o.temp }, modifier: "add", value: 1 });
        }
      }
      pre.push({ dword: field(advance, "dest"), modifier: "set", value: { epd: { temp: `${R}.nowhere` } } }, { dword: nextOf(R), modifier: "set", value: { label: back } });
      post.push({ dword: field(advance, "dest"), modifier: "set", value: { epd: nextOf(R) } });
      this.push({ conds: [], items: pre.map((act) => ({ act })), next: R, at });
      this.push({ label: back, conds: [], items: post.map((act) => ({ act })), at });
    };
    if (!negative) return run(false);
    const minus = this.label("tm"), joined = this.label("tj");
    this.branch(negative, minus, at);
    run(false);
    this.goto(joined);
    this.land(minus);
    run(true);
    this.land(joined);
  }

  /**
   * a × b, wrapping at 32 bits (the same bits signed or not). The side the value ranges leave fewer bits is tested a
   * bit at a time where it is (a masked condition costs Remastered nothing over a plain one), and the other is added for
   * each bit set — one of two ways:
   * - A tested side of a few bits (`SCALED_BITS`) times one variable the plan does not copy (`Scope.heavy`): a trigger
   *   a bit, adding the variable times the bit — a field each, a place of it its writes keep (13 ns a bit, 23 set).
   * - Otherwise Horner's way: the product so far doubles in a doubling trigger (`doubler`) that walks a run of triggers,
   *   a bit each, which add the other side when the bit is set: read in a field of each (about 46 ns a bit), or, for a
   *   side the plan may copy, in one shared trigger a flag sends the walk through, so that its cell is routed into one
   *   field (56 ns) and not one a bit (about 69 ns a bit). A side below zero is taken as its magnitude and the
   *   product negated as it comes out; groups of eight leading zeros are jumped over.
   * eudplib's product routes its operand through a call twice a bit, about 95 ns.
   */
  product(target: string, a: Linear, b: Linear, ra: Range | undefined, rb: Range | undefined, apart: boolean, at?: At): void {
    emitterCounts.products++;
    const [t, s, rt] = width(rb) <= width(ra) ? [b, a, rb] : [a, b, ra];
    const signed = !rt || rt[0] < 0, w = signed ? 32 : width(rt);
    if (w === 0) return this.write(target, { c: 0, terms: [] });
    // (A variable the plan does not copy keeps its multiples where it is written; so does a scratch value a product or a
    // quotient filled whose ranges leave it few bits, its copy into them a trigger a bit it can have.)
    const sTop = s.terms.length === 1 ? this.tops.get(s.terms[0].id) : undefined;
    const clean = s.terms.length === 1 && !this.scope.heavy.has(s.terms[0].id), narrow = sTop !== undefined && width([0, sTop]) <= SCALED_BITS;
    const temp = `${this.key}.mp${this.n++}`, from = this.beginFed(at);
    const fill = () => {
      this.routeFed(from);
      this.open().items.push({ fill: { temp, target, ...(apart ? { apart } : {}), ...(this.top !== undefined ? { top: this.top } : {}) } });
    };
    if ((clean || narrow) && !signed && w <= SCALED_BITS) {
      const T = this.home(this.alone(t, "mt"), 0), S = this.multiple(s, "ms");
      this.open().items.push({ act: { dword: { temp }, modifier: "set", value: 0 } });
      for (let j = w - 1; j >= 0; j--) this.push({ conds: [{ dword: T, compare: "atLeast", value: 1, mask: u(2 ** j) }], items: [{ act: this.times({ temp }, S, u(2 ** j)) }], at });
      return void fill();
    }
    const neg = `${this.key}.mn${this.n++}`;
    let T: Dword;
    if (signed) {
      // (Its magnitude: the side, or MAX less it plus 1 — read at its own scale, so that no field holds its negation.)
      const m = this.multiple(t, "mt"), mt = `${this.key}.mm${this.n++}`;
      this.setTo({ temp: mt }, m, at);
      this.push({ conds: [], items: [{ act: { dword: { temp: neg }, modifier: "set", value: 0 } }], at });
      this.push({ conds: [{ dword: { temp: mt }, compare: "atLeast", value: 1, mask: SIGN }], items: [{ act: { dword: { temp: mt }, modifier: "set", value: MAX } }, { act: this.times({ temp: mt }, m, 1, "subtract") }, { act: { dword: { temp: mt }, modifier: "add", value: 1 } }, { act: { dword: { temp: neg }, modifier: "set", value: 1 } }], at });
      T = { temp: mt };
    } else T = this.home(this.alone(t, "mt"), 0);
    const S = this.multiple(s, "ms");
    const R = this.label("hr"), A = this.label("ha"), done = this.label("hdone");
    const acc: Dword = { at: R, field: { act: 0, part: "value" } };
    const flag = `${this.key}.hf${this.n++}`, shared = !clean;
    const B = Array.from({ length: w }, () => this.label("hb"));
    this.push({ conds: [], items: [{ act: { dword: acc, modifier: "set", value: 0 } }, ...(shared ? [{ act: { dword: { temp: flag }, modifier: "set", value: 0 } } as Item, { act: { dword: nextOf(A), modifier: "set", value: { label: R } } } as Item] : [])], at });
    this.enter(w, (i) => B[i], R, (k) => ({ dword: T, compare: "atLeast", value: 2 ** k }), at);
    const bit = (label: string, i: number, next: string) => this.push({ label, conds: [{ dword: T, compare: "atLeast", value: 1, mask: u(2 ** (w - 1 - i)) }], items: [{ act: shared ? { dword: { temp: flag }, modifier: "set", value: 1 } : this.times(acc, S, 1) }], next, at });
    for (let i = 0; i + 1 < w; i++) bit(B[i], i, shared ? A : R);
    if (shared) {
      // (The last bit's place in the run points the shared addition at the end, and goes on to the last bit, laid out after.)
      const last = this.label("hlast");
      this.push({ label: B[w - 1], conds: [], items: [{ act: { dword: nextOf(A), modifier: "set", value: { label: done } } }], next: last, at });
      bit(last, w - 1, A);
      this.push({ label: A, conds: [{ dword: { temp: flag }, compare: "exactly", value: 1 }], items: [{ act: this.times(acc, S, 1) }, { act: { dword: { temp: flag }, modifier: "set", value: 0 } }], next: R, at });
    } else bit(B[w - 1], w - 1, done);
    this.doubler(R, [acc], B[0], at);
    this.land(done);
    this.takeOut(R, 1, [{ act: 0, temp }], signed ? [{ dword: { temp: neg }, compare: "exactly", value: 1 }] : null, at);
    fill();
  }

  /**
   * a / c or a % c by a constant c: eudplib's division chain by a constant, written where it is used instead of called —
   * a trigger for each bit the quotient can have, taking c times that bit from the remainder when it fits — with only
   * as many steps as the value ranges leave the dividend, and from the top a group of eight steps that cannot take
   * anything jumped over. Read as JavaScript's numbers, the magnitude is divided, by a chain for a dividend below zero
   * and one for the rest, each gathering the answer with its sign in one scratch cell: a quotient bit by bit, plus or
   * minus; a remainder below zero as the dividend plus what the chain takes away.
   */
  divideByConst(target: string, op: "/" | "%", a: Linear, c: number, unsigned: boolean, ra: Range | undefined, apart: boolean, at?: At): void {
    emitterCounts.quotients++;
    const d = unsigned ? u(c) : Math.abs(c | 0);
    if (d === 0) return this.write(target, { c: 0, terms: [] });
    const negC = !unsigned && (c | 0) < 0, negA = !unsigned && (!ra || ra[0] < 0);
    const most = unsigned ? (ra && ra[0] >= 0 ? ra[1] : MAX) : ra ? Math.max(Math.abs(ra[0]), Math.abs(ra[1])) : SIGN;
    const from = this.beginFed(at), A = this.multiple(a, "da");
    const key = `${this.key}.d${this.n++}`, out = `${key}.o`, rem = `${key}.r`;
    let top = -1;
    while (top < 31 && d * 2 ** (top + 1) <= most) top++;
    /** The chain; `minus`: the dividend below zero (its magnitude in `rem`). */
    const chain = (minus: boolean) => {
      // (The remainder of a dividend not below zero is worked in the answer's own cell.)
      const reg = op === "%" && !minus ? out : rem;
      for (let hi = top; hi >= 0; hi -= 8) {
        const lo = Math.max(0, hi - 7), past = this.label("dg");
        if (top > 7) this.branch([{ dword: { temp: reg }, compare: "atMost", value: d * 2 ** lo - 1 }], past, at);
        for (let i = hi; i >= lo; i--) {
          const x = d * 2 ** i, acts: Act[] = [{ dword: { temp: reg }, modifier: "subtract", value: x }];
          if (op === "/") acts.push({ dword: { temp: out }, modifier: "add", value: u((minus !== negC ? -1 : 1) * 2 ** i) });
          else if (minus) acts.push({ dword: { temp: out }, modifier: "add", value: x });
          this.push({ conds: [{ dword: { temp: reg }, compare: "atLeast", value: x }], items: acts.map((act) => ({ act })), at });
        }
        this.land(past);
      }
    };
    if (op === "/" || negA) this.setTo({ temp: rem }, A, at);
    if (op === "%") this.setTo({ temp: out }, A, at);
    else this.push({ conds: [], items: [{ act: { dword: { temp: out }, modifier: "set", value: 0 } }], at });
    if (!negA) chain(false);
    else {
      const below = this.label("dn"), done = this.label("dd");
      this.branch([{ dword: { temp: rem }, compare: "atLeast", value: 1, mask: SIGN }], below, at);
      chain(false);
      this.goto(done);
      this.land(below);
      // (The magnitude: MAX less the dividend, plus 1.)
      this.push({ conds: [], items: [{ act: { dword: { temp: rem }, modifier: "set", value: MAX } }, { act: this.times({ temp: rem }, A, 1, "subtract") }, { act: { dword: { temp: rem }, modifier: "add", value: 1 } }], at });
      chain(true);
      this.land(done);
    }
    this.routeFed(from);
    this.open().items.push({ fill: { temp: out, target, ...(apart ? { apart } : {}), ...(this.top !== undefined ? { top: this.top } : {}) } });
  }

  /**
   * a / b or a % b of two values: long division with the remainder doubling (`doubler`, which also doubles the
   * quotient) — a step a bit of the dividend's magnitude: the bit added to the remainder, then one trigger shared by
   * every step taking b from it when it fits and adding 1 to the quotient. b's magnitude is set into that trigger's two
   * fields before the steps — two, whatever the number of steps, no place of b in each. A dividend below zero is read as itself less 1, whose clear bits are its magnitude's set ones (a run of
   * steps of its own); the answer is negated as it comes out. Groups of eight leading zeros are jumped over. About 80 ns
   * a step, and only as many steps as the dividend has bits; eudplib's division routes the divisor into two fields of
   * each of 32 steps first, doubling it each time, whatever the numbers: about 6.5 µs.
   */
  divide(target: string, op: "/" | "%", a: Linear, b: Linear, unsigned: boolean, ra: Range | undefined, rb: Range | undefined, apart: boolean, at?: At): void {
    emitterCounts.quotients++;
    const signed = !unsigned, negA = signed && (!ra || ra[0] < 0), negB = signed && (!rb || rb[0] < 0);
    const from = this.beginFed(at), Am = this.multiple(a, "va"), Bm = this.multiple(b, "vb");
    const key = `${this.key}.v${this.n++}`, out = `${key}.o`, neg = `${key}.neg`, am = `${key}.a`;
    const R = this.label("vr"), T = this.label("vt"), done = this.label("vdone"), joined = this.label("vout");
    const rem: Dword = { at: R, field: { act: 0, part: "value" } }, q: Dword = { at: R, field: { act: 1, part: "value" } };
    const cells = op === "/" ? [rem, q] : [rem];
    // b straight into the shared step's two fields (and tested there), a into the cell its bits are tested in.
    const divisor: Dword[] = [{ at: T, field: { cond: 0 } }, { at: T, field: { act: 0, part: "value" } }];
    for (const f of divisor) this.setTo(f, Bm, at);
    this.setTo({ temp: am }, Am, at);
    // (The shared step goes back to the doubling trigger until the last step points it at the end.)
    this.push({ conds: [], items: [{ act: { dword: { temp: neg }, modifier: "set", value: 0 } }, { act: { dword: nextOf(T), modifier: "set", value: { label: R } } }, ...cells.map((d) => ({ act: { dword: d, modifier: "set", value: 0 } as Act }))], at });
    // By 0, 0; read from 0 up, a divisor past 2^31 fits once at most (and doubling the remainder could pass 32 bits);
    // below zero, its magnitude.
    const zero = this.label("vz"), big = this.label("vbig");
    this.branch([{ dword: divisor[0], compare: "exactly", value: 0 }], zero, at);
    if (unsigned && !(rb && rb[0] >= 0)) this.branch([{ dword: divisor[0], compare: "atLeast", value: SIGN + 1 }], big, at);
    if (negB) {
      const bdone = this.label("vbd");
      this.branch([{ dword: divisor[0], compare: "atMost", value: SIGN - 1 }], bdone, at);
      this.push({ conds: [], items: [...divisor.flatMap((f) => [{ act: { dword: f, modifier: "set", value: MAX } as Act }, { act: this.times(f, Bm, 1, "subtract") }, { act: { dword: f, modifier: "add", value: 1 } as Act }]), { act: { dword: { temp: neg }, modifier: "add", value: 2 } }], at });
      this.land(bdone);
    }
    // The dividend's bits, and into the steps.
    const most = unsigned ? (ra && ra[0] >= 0 ? ra[1] : MAX) : ra ? Math.max(Math.abs(ra[0]), Math.abs(ra[1])) : SIGN;
    const n = Math.max(1, width([0, most]));
    const plus = Array.from({ length: n }, () => this.label("vb")), minus = negA ? Array.from({ length: n }, () => this.label("vbm")) : [];
    if (negA) {
      const below = this.label("van");
      this.branch([{ dword: { temp: am }, compare: "atLeast", value: 1, mask: SIGN }], below, at);
      this.enter(n, (i) => plus[i], R, (k) => ({ dword: { temp: am }, compare: "atLeast", value: 2 ** k }), at);
      this.land(below);
      this.push({ conds: [], items: [{ act: { dword: { temp: am }, modifier: "subtract", value: 1 } }, { act: { dword: { temp: neg }, modifier: "add", value: 1 } }], at });
      this.enter(n, (i) => minus[i], R, (k) => ({ dword: { temp: am }, compare: "atMost", value: MAX - 2 ** k }), at);
    } else this.enter(n, (i) => plus[i], R, (k) => ({ dword: { temp: am }, compare: "atLeast", value: 2 ** k }), at);
    // A step's bit, in its run; the last step's place in the run is a trigger pointing the shared step at the end, which
    // goes on to the last bit, laid out after.
    const lastBits: [string, boolean][] = [];
    const bit = (label: string, set: boolean, i: number): Proto => this.push({
      label, conds: [{ dword: { temp: am }, compare: set ? "atLeast" : "exactly", value: set ? 1 : 0, mask: u(2 ** (n - 1 - i)) }],
      items: [{ act: { dword: rem, modifier: "add", value: 1 } }], next: T, at,
    });
    for (const [list, set] of [[plus, true], [minus, false]] as const) list.forEach((label, i) => {
      if (i + 1 < n) return void bit(label, set, i);
      const last = this.label("vlast");
      this.push({ label, conds: [], items: [{ act: { dword: nextOf(T), modifier: "set", value: { label: done } } }], next: last, at });
      lastBits.push([last, set]);
    });
    for (const [label, set] of lastBits) bit(label, set, n - 1);
    this.push({ label: T, conds: [{ dword: rem, compare: "atLeast", value: 0 }], items: [{ act: { dword: rem, modifier: "subtract", value: 0 } }, ...(op === "/" ? [{ act: { dword: q, modifier: "add", value: 1 } } as Item] : [])], next: R, at });
    this.doubler(R, cells, plus[0], at);
    this.land(done);
    const negative: Cond[] = op === "/" ? [{ dword: { temp: neg }, compare: "atLeast", value: 1 }, { dword: { temp: neg }, compare: "atMost", value: 2 }] : [{ dword: { temp: neg }, compare: "atLeast", value: 1, mask: 1 }];
    this.takeOut(R, cells.length, [{ act: op === "/" ? 1 : 0, temp: out }], signed ? negative : null, at);
    this.goto(joined);
    if (unsigned && !(rb && rb[0] >= 0)) {
      // (Read from 0 up: the quotient 1 when b fits, the remainder a less b then.)
      this.land(big);
      this.push({ conds: [], items: [{ act: op === "/" ? { dword: { temp: out }, modifier: "set", value: 0 } : this.times({ temp: out }, Am, 1, "set") }], at });
      const fits = this.against({ temp: am }, "atLeast", Bm);
      this.push({ conds: [fits], items: [{ act: op === "/" ? { dword: { temp: out }, modifier: "set", value: 1 } : this.times({ temp: out }, Bm, 1, "subtract") }], at });
      this.goto(joined);
    }
    this.land(zero);
    this.push({ conds: [], items: [{ act: { dword: { temp: out }, modifier: "set", value: 0 } }], at });
    this.land(joined);
    this.routeFed(from);
    this.open().items.push({ fill: { temp: out, target, ...(apart ? { apart } : {}), ...(this.top !== undefined ? { top: this.top } : {}) } });
  }

  /** A map of our own's regions of cell triggers for its arrays, by id: one for each array a statement reaches. */
  regions = new Map<string, Region>();
  region(a: ArrayDecl): void {
    if (!this.regions.has(a.id)) this.regions.set(a.id, { id: a.id, cells: Math.max(1, a.length), ...(a.values ? { values: a.values.map(u) } : {}) });
  }

  /** A sum as one variable: itself when it is one, else a variable of the emitter's own it is written into. */
  alone(l: Linear, name: string): string {
    if (l.c === 0 && l.terms.length === 1 && l.terms[0].k === 1) return l.terms[0].id;
    const id = `${this.key}.${name}${this.n++}`;
    this.own.add(id);
    this.write(id, l, false);
    return id;
  }

  /**
   * A sum as one variable whose places will be fields no refresh reaches — a store's destination or number, a jump's
   * next pointer, a frame's cell: `alone`'s on the Python side; in a map of our own always a variable of the emitter's
   * own, written just before. Where that stands for a variable of the program's, the graph puts the variable itself
   * back in the fields (`fuse`) unless the plan copies it: the variable of the emitter's own is there for the few whose
   * places would run into the thousands, which the plan copies and so reads where they are used.
   */
  pin(l: Linear, name: string): string {
    if (!this.scope.native) return this.alone(l, name);
    const id = `${this.key}.${name}${this.n++}`;
    this.own.add(id);
    this.write(id, l, false);
    if (l.c === 0 && l.terms.length === 1 && l.terms[0].k === 1) this.pins.set(id, l.terms[0].id);
    return id;
  }

  /** A variable of the emitter's own (`pin`) replaced by the variable it stands for, everywhere: its places, its write gone. */
  fuse(own: string, by: string, pinned: Set<string>): void {
    const was = this.placesOf(own), home = was[0].dword!, to = this.placesOf(by);
    to.push(...was.slice(1));
    this.places.delete(own);
    const key = JSON.stringify(home);
    for (const p of this.protos) {
      p.conds = p.conds.map((c) => (JSON.stringify(c.dword) === key ? { ...c, dword: to[0].dword! } : c));
      p.items = p.items.filter((it) => !("write" in it && it.write.target === own));
    }
    this.writes.delete(own);
    const rename = <R extends { id: string }>(r: R | undefined): R | undefined => (r && r.id === own ? { ...r, id: by } : r);
    for (const [label, r] of this.jumpReads) this.jumpReads.set(label, rename(r)!);
    for (const [act, ap] of this.actPlaces) this.actPlaces.set(act, { ...(ap.dest ? { dest: rename(ap.dest) } : {}), ...(ap.value ? { value: rename(ap.value) } : {}) });
    for (const [c, r] of this.condReads) this.condReads.set(c, rename(r)!);
    for (const [c, r] of this.condPlayers) this.condPlayers.set(c, rename(r)!);
    this.own.delete(own);
    pinned.delete(own);
    pinned.add(by);
  }

  /**
   * A cell of an array a map of our own keeps, into `target`: a trigger that sets a scratch cell to 0, points the cell
   * trigger's action at it and its next pointer back here, and goes to it — the three a place of the index (its
   * destination and next pointer 18 EPD a cell apart, the cell 72 bytes) — and then the scratch cell into every place
   * of the target (`graph` reads the cell straight into the target instead when its cell is its only place). An index
   * outside the array (read from 0 up; a window's own index against its own length) reads 0; one the value ranges know
   * is inside is not tested.
   */
  readCell(target: string, t: Table, at?: At): void {
    const a = t.array;
    this.region(a);
    const index = this.pin(t.index, "ci");
    const temp = `${this.key}.ct${this.n++}`, after = this.label("cget"), out = this.label("cout"), jump = this.label("cjmp");
    if (!t.safe) {
      const guard = t.guard ? this.alone(t.guard, "cg") : index;
      this.jump({ kind: "compare", op: ">=", left: { kind: "var", id: guard }, right: { kind: "const", value: t.limit ?? a.length }, unsigned: true, at: at!, label: "" } as BoolExpr, true, out, at);
    }
    const point: Act = { dword: { element: a.id }, modifier: "set", value: { epd: { temp } } };
    const back: Act = { dword: { element: a.id }, modifier: "set", value: { label: after } };
    this.actPlaces.set(point, { dest: { id: index, scale: VARRAY_STRIDE_EPD, add: -1, base: a.id } });
    this.actPlaces.set(back, { dest: { id: index, scale: VARRAY_STRIDE_EPD, add: -86, base: a.id } });
    this.push({ label: jump, conds: [], items: [{ act: { dword: { temp }, modifier: "set", value: 0 } }, { act: point }, { act: back }], next: after, keep: true, at });
    this.jumpReads.set(jump, { id: index, scale: 72, add: 0, base: `addr:${a.id}` });
    if (!t.safe) {
      this.land(out);
      this.push({ conds: [], items: [{ act: { dword: { temp }, modifier: "set", value: 0 } }], next: after, at });
    }
    this.land(after);
    this.open().items.push({ fill: { temp, target } });
  }

  /**
   * An array declared (a map of our own): each cell set to its value from the list, or all to the one value (`fill`) —
   * a constant as it is, anything else into a variable of the emitter's own whose places the cells' actions are. 64 to
   * a trigger, each trigger of them alone: an action's place is its index in its trigger.
   */
  declareArray(s: Extract<Stmt, { kind: "declareArray" }>): void {
    const a = this.scope.arrays.get(s.array)!;
    this.region(a);
    const fill = s.fill !== undefined ? linear(s.fill as NumExpr)! : null;
    const fillFrom = fill && fill.terms.length ? this.pin(fill, "fv") : null;
    const acts: Act[] = [];
    for (let i = 0; i < a.length; i++) {
      const v = fill ?? (s.init?.[i] !== undefined ? linear(s.init[i] as NumExpr)! : { c: 0, terms: [] });
      const from = fill ? fillFrom : v.terms.length ? this.pin(v, "iv") : null;
      const act: Act = { dword: { cell: a.id, index: i }, modifier: "set", value: from ? 0 : v.c };
      if (from) this.actPlaces.set(act, { value: { id: from, scale: 1, add: 0 } });
      acts.push(act);
    }
    for (let i = 0; i < acts.length; i += MOST_ACTS) this.push({ conds: [], items: acts.slice(i, i + MOST_ACTS).map((act) => ({ act })) });
    this.push({ conds: [], items: [] });
  }

  /**
   * A store into a cell of an array: one trigger, its condition the index inside the array (read from 0 up: one below
   * zero is past the end, where a store does nothing), its action setting the cell — the action's destination a place
   * of the index (the EPD of the first cell's value, plus the index times the EPD between cells), its number a place
   * of the value. An index or a value that is more than a variable goes into a variable of the emitter's own first.
   */
  store(st: Store): void {
    const stride = this.scope.native || st.array.length <= VARRAY_MOST ? VARRAY_STRIDE_EPD : 1;
    if (this.scope.native) this.region(st.array);
    else this.arrays.set(st.array.id, stride);
    const alone = (l: Linear) => l.c === 0 && l.terms.length === 1 && l.terms[0].k === 1;
    let index: string;
    if (this.scope.native) index = this.pin(st.index, "si");
    else if (alone(st.index)) index = st.index.terms[0].id;
    else {
      index = `${this.key}.si${this.n++}`;
      this.own.add(index);
      this.write(index, st.index, false);
    }
    const own = new Map(st.reads.map((r) => [r.id, `${this.key}.${r.id.slice(1)}`]));
    for (const r of st.reads) {
      this.own.add(own.get(r.id)!);
      if (r.arith || r.table?.jump) this.scope.heavy.add(own.get(r.id)!);
      if (r.table) this.readTable(own.get(r.id)!, r.table, this.at);
      else if (r.shift) this.readShift(own.get(r.id)!, r.shift, this.at);
      else this.arith(own.get(r.id)!, r.arith!, own, this.at);
    }
    const value: Linear = { c: st.value.c, terms: st.value.terms.map((t) => ({ id: own.get(t.id) ?? t.id, k: t.k })) };
    let from: string | null = null;
    if (value.terms.length && this.scope.native) from = this.pin(value, "sv");
    else if (value.terms.length && alone(value)) from = value.terms[0].id;
    else if (value.terms.length) {
      from = `${this.key}.sv${this.n++}`;
      this.own.add(from);
      this.write(from, value, false);
    }
    const act: Act = { dword: { element: st.array.id }, modifier: "set", value: from ? 0 : value.c };
    this.actPlaces.set(act, { dest: { id: index, scale: stride, add: 0, base: st.array.id }, ...(from ? { value: { id: from, scale: 1, add: 0 } } : {}) });
    // (A window's guard is its own index against its own length. One the value ranges know is inside tests nothing,
    // and the writes after it go in its trigger.)
    if (st.safe) { this.push({ conds: [], items: [{ act }] }); return; }
    const guard = st.guard ? this.alone(st.guard, "sg") : index;
    this.push({ conds: [{ dword: this.home(guard, 0), compare: "atMost", value: (st.limit ?? st.array.length) - 1 }], items: [{ act }] });
  }

  /** A statement left to the Python side, where it is; what it may write copied back into the graph's places after. */
  left(s: Stmt): void {
    const writes = this.scope.islands.get(s);
    if (!writes) throw new Error(`emitter: ${s.kind}`);
    const p = this.open();
    p.items.push({ island: s, writes });
  }

  // ── the writes, once every place is known ──

  /**
   * The variables that are copied into their places after each write, and the order the others' writes are expanded
   * in. A write of x reads y into an action for each place of x, and each of those is a place of y: so y's writes are
   * expanded after x's. Where that goes round — x set from itself other than by adding, x and y reading each other —
   * the variables of the loop are copied instead: their writes go to their cells alone, and a copy after each write
   * fills the rest of their places (a routed read each, as eudplib's every read is).
   */
  plan(pinned = new Set<string>()): { copied: Set<string>; order: string[] } {
    const readers = new Map<string, Set<string>>(); // v → the targets whose writes read v
    const copied = new Set<string>([...this.forced, ...this.results]);
    for (const [target, ws] of this.writes) for (const w of ws) {
      const self = w.value.terms.filter((t) => t.id === target);
      if (self.length && self[0].k !== 1) copied.add(target);
      for (const t of w.value.terms) {
        if (t.id === target) continue;
        if (!readers.has(t.id)) readers.set(t.id, new Set());
        readers.get(t.id)!.add(target);
      }
    }
    // Every loop of the graph of reads (Tarjan's strongly connected parts of more than one variable) broken by copies.
    // The Python side's loops copy every variable of a part (a copy there is a routed read a place). A map of our own
    // copies as few as it can — a copy there is a trigger a bit — the variable whose writes are fewest, each weighed by
    // the loops around it, and then the part again without it: calls make such loops whenever what a function gives
    // back reaches its own parameters (`pick(a, pick(b, c))`, `i = next(i)`), and one copy breaks each.
    const strong = (nodes: Set<string>): string[][] => {
      const index = new Map<string, number>(), low = new Map<string, number>(), stack: string[] = [], on = new Set<string>(), out: string[][] = [];
      let n = 0;
      const connect = (v: string): void => {
        index.set(v, n); low.set(v, n++); stack.push(v); on.add(v);
        for (const w of readers.get(v) ?? []) {
          if (!nodes.has(w)) continue;
          if (!index.has(w)) { connect(w); low.set(v, Math.min(low.get(v)!, low.get(w)!)); }
          else if (on.has(w)) low.set(v, Math.min(low.get(v)!, index.get(w)!));
        }
        if (low.get(v) === index.get(v)) {
          const part: string[] = [];
          for (let w = stack.pop()!; ; w = stack.pop()!) { on.delete(w); part.push(w); if (w === v) break; }
          out.push(part);
        }
      };
      for (const v of nodes) if (!index.has(v)) connect(v);
      return out;
    };
    const weight = new Map<string, number>();
    for (const p of this.protos) for (const it of p.items) if ("write" in it) weight.set(it.write.target, (weight.get(it.write.target) ?? 0) + 4 ** (p.depth ?? 0));
    const breakUp = (nodes: Set<string>): void => {
      for (const part of strong(nodes)) {
        if (part.length < 2) continue;
        // (Copying the program's variables of a loop breaks it: the emitter's own have no cell to copy from.)
        const real = part.filter((x) => !this.own.has(x) && !isTemp(x));
        const candidates = real.length ? real : part;
        if (!this.scope.native) { candidates.forEach((x) => copied.add(x)); continue; }
        const pick = candidates.reduce((a, b) => ((weight.get(b) ?? 0) < (weight.get(a) ?? 0) ? b : a));
        copied.add(pick);
        breakUp(new Set(part.filter((x) => x !== pick)));
      }
    };
    breakUp(new Set([...this.writes.keys(), ...readers.keys()].filter((v) => !this.scope.native || !copied.has(v))));
    // The rest in order: a variable after every target whose writes read it, the copied ones being no target (their
    // writes have one place each, whatever their places are).
    const out: string[] = [...copied].filter((v) => this.writes.has(v)), done = new Set<string>(out);
    const visit = (v: string): void => {
      if (done.has(v)) return;
      done.add(v);
      for (const t of readers.get(v) ?? []) if (!copied.has(t)) visit(t);
      out.push(v);
    };
    for (const v of this.writes.keys()) visit(v);
    // A map of our own: places counted in that order — a variable's own, and for each write that reads it, one for
    // each place of the target (one, a target that is copied) — and a variable that would have more than a trigger's
    // worth copied instead, so that it is read where it is used (routed). Every place of a target that reads it is a
    // place of it, so along a run of variables each set from the one before, places multiply; arrays and the values
    // functions give back make such runs, which reached thousands of places before. (Not a variable a store's or a
    // jump's fields hold: those are never refreshed where they are read.)
    if (this.scope.native) {
      const count = new Map<string, number>();
      for (const v of out) {
        let n = this.places.get(v)?.length ?? 1;
        for (const t of readers.get(v) ?? []) for (const w of this.writes.get(t) ?? []) {
          const k = w.value.terms.filter((x) => x.id === v).length;
          n += copied.has(t) ? k : k * (count.get(t) ?? 1);
        }
        count.set(v, n);
        if (n > MOST_ACTS && !pinned.has(v)) copied.add(v);
      }
    }
    return { copied, order: out };
  }

  /**
   * A write expanded: for every place of the target, the actions that make it the new value — the place's multiple of
   * each part. Only adds and sets: the game's subtract stops at 0, so a part taken away is its negation added.
   */
  expand(w: Write, copied: boolean): WriteAct[] {
    const out: WriteAct[] = [];
    // x = x + …: added where it is. (A copied x may read itself otherwise: its write has its cell alone, and the
    // places it reads x from are filled by the copy after.)
    const inPlace = w.value.terms.some((t) => t.id === w.target && t.k === 1);
    const terms = inPlace ? w.value.terms.filter((t) => t.id !== w.target) : w.value.terms;
    for (const into of copied ? this.placesOf(w.target).slice(0, 1) : this.placesOf(w.target)) {
      const c = mul(into.scale, w.value.c);
      const parts = terms.map((t) => ({ id: t.id, scale: mul(into.scale, t.k) })).filter((t) => t.scale !== 0);
      if (inPlace) {
        if (c) out.push({ into, modifier: "add", value: c });
      } else if (parts.length) {
        const first = parts.shift()!;
        out.push({ into, modifier: "set", value: 0, reads: { id: first.id, scale: first.scale, add: u(c + into.add), ...(into.base ? { base: into.base } : {}) } });
      } else out.push({ into, modifier: "set", value: num(u(c + into.add), into.base) });
      for (const t of parts) out.push({ into, modifier: "add", value: 0, reads: { id: t.id, scale: t.scale, add: 0 } });
    }
    return out;
  }

  graph(entries: string[]): Graph | string {
    // A comparison's number is a place of what it reads: its trigger keeps its label and the condition its index.
    for (const p of this.protos) p.conds.forEach((c, k) => {
      const r = this.condReads.get(c);
      if (r) this.placesOf(r.id).push({ dword: { at: p.label, field: { cond: k } }, scale: r.scale, add: r.add });
      const q = this.condPlayers.get(c);
      if (q) this.placesOf(q.id).push({ dword: { at: p.label, field: { cond: k, part: "player" } }, scale: q.scale, add: q.add, base: q.base });
    });
    // A store's destination and number are places of its index and value: its trigger keeps its label (it has a
    // condition), its actions follow the puts-back that land there. A jump's next pointer is a place of its index.
    const pinned = new Set<string>();
    for (const [label, r] of this.jumpReads) {
      this.placesOf(r.id).push({ dword: { at: label, field: "next" }, scale: r.scale, add: r.add, base: r.base });
      pinned.add(r.id);
    }
    for (const p of this.protos) {
      let k = this.restores.get(p.label)?.length ?? 0;
      for (const it of p.items) {
        if (!("act" in it)) continue;
        const ap = this.actPlaces.get(it.act);
        if (ap) {
          for (const [part, r] of [["dest", ap.dest], ["value", ap.value]] as const) {
            if (!r) continue;
            this.placesOf(r.id).push({ dword: { at: p.label, field: { act: k, part } }, scale: r.scale, add: r.add, ...(r.base ? { base: r.base } : {}) });
            pinned.add(r.id);
          }
        }
        k++;
      }
    }
    // The variables of the emitter's own standing for one of the program's in a field, the variable itself there
    // instead, unless the plan copies it.
    const first = this.plan(pinned);
    let fused = false;
    for (const [own, by] of this.pins) {
      if (first.copied.has(by) || first.copied.has(own) || !this.writes.has(own)) continue;
      this.fuse(own, by, pinned);
      fused = true;
    }
    const { copied, order } = fused ? this.plan(pinned) : first;
    // (A variable of the emitter's own has no cell on the Python side to copy from; in a map of our own it has.)
    if (!this.scope.native && [...copied].some((id) => this.own.has(id) || isTemp(id))) return "a variable of the emitter's own would be copied";
    // Each target's writes expanded once all its places are known — the writes that read it come first in the
    // order, and each action that reads a variable is a place of it.
    const expanded = new Map<Write, WriteAct[]>();
    for (const v of order) for (const w of this.writes.get(v) ?? []) {
      const acts = this.expand(w, copied.has(v));
      expanded.set(w, acts);
      for (const a of acts) if (a.reads) this.placesOf(a.reads.id).push({ act: a, scale: a.reads.scale, add: a.reads.add, ...(a.reads.base ? { base: a.reads.base } : {}) });
    }
    // Every fall-through said, so that dropping a trigger leaves the one before it going where it went.
    this.protos.forEach((p, i) => { if (p.next === undefined) p.next = this.protos[i + 1]?.label ?? END; });
    // Empty triggers dropped: their labels stand for where they went.
    const alias = new Map<string, string>();
    const kept: Proto[] = [];
    for (const p of this.protos) {
      if (p.conds.length === 0 && p.items.length === 0 && !p.keep && !this.restores.get(p.label)?.length) alias.set(p.label, p.next!);
      else kept.push(p);
    }
    const resolve = (l: string): string => {
      while (alias.has(l)) l = alias.get(l)!;
      return l;
    };
    // Routed variables: a variable whose writes would each be copied into its places (a call's result, one an island
    // writes, one copied for a loop of reads) is instead read where it is used — the dwords a trigger is about to read
    // refreshed from its cell just before it — when that is cheaper: its reads against its writes times its places,
    // each weighed by how deep in the graph's loops it is (a loop inside counted as four turns of the one outside).
    const protoOf = new Map<Write, Proto>(), protoBy = new Map(this.protos.map((p) => [p.label, p]));
    for (const p of this.protos) for (const it of p.items) if ("write" in it) protoOf.set(it.write, p);
    const writeOf = new Map<WriteAct, Write>();
    for (const [w, acts] of expanded) for (const a of acts) writeOf.set(a, w);
    const weight = (p?: Proto) => 4 ** (p?.depth ?? 0);
    const written = new Map<string, number>();
    const wrote = (id: string, by: number) => written.set(id, (written.get(id) ?? 0) + by);
    for (const p of this.protos) for (const it of p.items) {
      if ("copy" in it && copied.has(it.copy)) wrote(it.copy, weight(p));
      if ("island" in it) for (const id of it.writes) wrote(id, weight(p));
    }
    const routed = new Set<string>();
    for (const [id, w] of written) {
      const ps = this.places.get(id) ?? [];
      if ((!this.scope.native && (this.own.has(id) || isTemp(id))) || ps.length <= 1 || pinned.has(id) || ps.some((p) => p.synced)) continue;
      let read = 0;
      for (const p of ps.slice(1)) {
        if (p.act) read += weight(protoOf.get(writeOf.get(p.act)!));
        else if (p.dword && "at" in p.dword) read += weight(protoBy.get(p.dword.at));
        else if (p.dword && "data" in p.dword) for (const q of this.protos) if (q.conds.some((c) => "data" in c.dword && c.dword.data === (p.dword as { data: string }).data)) read += weight(q);
      }
      if (read < w * (ps.length - 1)) routed.add(id);
    }
    // What a trigger's conditions read of routed variables: the places refreshed before it.
    const condReads = (p: Proto): Map<string, Place[]> => {
      const out = new Map<string, Place[]>();
      for (const id of routed) for (const pl of this.places.get(id)!.slice(1)) {
        const d = pl.dword;
        const here = d && (("at" in d && d.at === p.label && typeof d.field === "object" && "cond" in d.field) || ("data" in d && p.conds.some((c) => "data" in c.dword && c.dword.data === d.data)));
        if (here) out.set(id, [...(out.get(id) ?? []), pl]);
      }
      return out;
    };
    // A trigger with conditions that reads routed variables is entered through its refreshes: what goes to it goes to them.
    const entry = new Map<string, string>();
    for (const p of kept) if (p.conds.length && condReads(p).size) entry.set(p.label, `${p.label}.in`);
    const to = (l: string): string => {
      const r = resolve(l);
      return entry.get(r) ?? r;
    };
    const cellOf = new Map<Place, string>();
    for (const [id, ps] of this.places) cellOf.set(ps[0], id);
    // The triggers: puts-back and actions in order, cut at 64 and around the copies.
    const triggers: Trigger[] = [];
    const at = new Map<WriteAct, Dword>();
    const later: { t: Trigger; k: number; w: WriteAct }[] = [];
    const copies: { t: Trigger; id: string }[] = [];
    const refreshes: { t: Trigger; places: (Place | WriteAct)[] }[] = [];
    const fills: { t: Trigger; target: string; apart?: boolean }[] = [];
    const afterIslands = new Set<Trigger>();
    /** The copies into dwords of their own (`route`): their `into` is theirs, not the variable's places. */
    const routes = new Set<Trigger>();
    /** The actions whose fields are places (a store's): their trigger is the one the proto's label names. */
    const fixed = new Set<Act>();
    let n = 0;
    for (const p of kept) {
      type Piece = { acts: (Act | WriteAct)[] } | { fill: { temp: string; target: string; apart?: boolean; top?: number } } | { copy: string; at?: At; island?: boolean; top?: number } | { island: Stmt } | { call: { fn: FixedFn; target: string }; at?: At } | { refresh: string; places: (Place | WriteAct)[] } | { route: { from: string; into: Dword[] } };
      const pieces: Piece[] = [{ acts: [] }];
      const acts = () => {
        const last = pieces[pieces.length - 1];
        if ("acts" in last) return last.acts;
        const fresh = { acts: [] };
        pieces.push(fresh);
        return fresh.acts;
      };
      for (const r of this.restores.get(p.label) ?? []) acts().push({ dword: { at: r.branch, field: "next" }, modifier: "set", value: { label: to(r.to) } });
      for (const it of p.items) {
        if ("act" in it) {
          const a: Act = { ...it.act, value: typeof it.act.value === "object" && "label" in it.act.value ? { label: to(it.act.value.label) } : it.act.value };
          if (this.actPlaces.has(it.act)) fixed.add(a);
          acts().push(a);
        }
        else if ("write" in it) acts().push(...expanded.get(it.write)!);
        else if ("bump" in it) {
          const ps = this.placesOf(it.bump.target);
          if (!copied.has(it.bump.target) && ps.length > MOST_ACTS - 1) this.crowded.add(it.bump.target);
          for (const into of copied.has(it.bump.target) ? ps.slice(0, 1) : ps) acts().push({ into, modifier: "add", value: mul(into.scale, it.bump.add) } as WriteAct);
        }
        else if ("fill" in it) pieces.push({ fill: it.fill });
        else if ("route" in it) pieces.push({ route: it.route });
        else if ("label" in it) {
          for (const pl of this.placesOf(it.label.target)) {
            if (!pl.dword || pl.scale !== 1 || pl.add !== 0) throw new Error(`emitter: a place of ${it.label.target} that is no dword of its own`);
            acts().push({ dword: pl.dword, modifier: "set", value: { label: to(it.label.to) } });
          }
        }
        else if ("copy" in it) { if (copied.has(it.copy) && !routed.has(it.copy)) pieces.push({ copy: it.copy, ...(it.at ? { at: it.at } : {}) }); }
        else if ("call" in it) pieces.push({ call: it.call, ...(it.at ? { at: it.at } : {}) });
        else {
          pieces.push({ island: it.island });
          // What it may write, back into every place but the cell.
          // (Not into the offsets the Python side keeps beside a counter: its own lowering of the store stepped them.)
          const top = this.scope.tops.get(it.island);
          for (const id of it.writes) if ((this.places.get(id)?.filter((p) => !p.synced).length ?? 0) > 1 && !routed.has(id)) pieces.push({ copy: id, island: true, ...(top !== undefined ? { top } : {}), ...(it.island.at ? { at: it.island.at as At } : {}) });
        }
      }
      if (p.conds.length && (pieces.length > 1 || (pieces[0] as { acts: unknown[] }).acts.length > MOST_ACTS)) return this.crowded.size ? "crowded" : "a branch with too many actions";
      // Routed variables: an action that reads one has its number refreshed from the cell just before its trigger
      // (again after a write of the variable earlier in the same run of actions); conditions likewise.
      const cut: Piece[] = [];
      if (p.conds.length) for (const [id, ps] of condReads(p)) cut.push({ refresh: id, places: ps });
      for (const piece of pieces) {
        if (!("acts" in piece) || p.conds.length) { cut.push(piece); continue; }
        let cur: (Act | WriteAct)[] = [], need = new Map<string, WriteAct[]>(), dirty = new Set<string>();
        const flush = () => {
          for (const [id, list] of need) cut.push({ refresh: id, places: list });
          if (cur.length) cut.push({ acts: cur });
          cur = [];
          need = new Map();
          dirty = new Set();
        };
        // A write at a time: every value it reads is the one from before it (its own target's too), so what it reads
        // is refreshed before its first action, and what it writes is stale for the writes after it.
        const groups: (Act | WriteAct)[][] = [];
        for (const a of piece.acts) {
          const w = "into" in a ? writeOf.get(a as WriteAct) : undefined;
          const last = groups[groups.length - 1];
          if (w && last && last.length && writeOf.get(last[0] as WriteAct) === w) last.push(a);
          else groups.push([a]);
        }
        for (const group of groups) {
          const reads = group.filter((a): a is WriteAct => "into" in a && !!a.reads && routed.has(a.reads.id));
          // (A refresh is a trigger before the actions it is for: not before an action whose fields are places, which
          // keeps the label.)
          if (reads.some((a) => dirty.has(a.reads!.id)) || (reads.length && cur.some((a) => fixed.has(a as Act)))) flush();
          for (const a of reads) need.set(a.reads!.id, [...(need.get(a.reads!.id) ?? []), a]);
          cur.push(...group);
          for (const a of group) {
            const owner = "into" in a ? cellOf.get(a.into) : undefined;
            if (owner && routed.has(owner)) dirty.add(owner);
          }
        }
        flush();
      }
      if (!cut.length) cut.push({ acts: [] });
      pieces.splice(0, pieces.length, ...cut);
      // Each piece one trigger or more: the first takes the label and the conditions, each goes to the one after it.
      const made: Trigger[] = [];
      const label = () => (made.length ? `${this.key}.cut${n++}` : entry.get(p.label) ?? p.label);
      for (const piece of pieces) {
        if ("refresh" in piece) {
          const t: Trigger = { label: label(), conds: [], acts: [], copy: { from: piece.refresh, into: [] }, ...(p.at ? { at: p.at } : {}) };
          refreshes.push({ t, places: piece.places });
          made.push(t);
          continue;
        }
        if ("route" in piece) {
          const t: Trigger = { label: label(), conds: [], acts: [], copy: { from: piece.route.from, into: piece.route.into.map((dword) => ({ dword, add: 0 })) }, ...(p.at ? { at: p.at } : {}) };
          routes.add(t);
          made.push(t);
          continue;
        }
        if ("fill" in piece) {
          const t: Trigger = { label: label(), conds: [], acts: [], copy: { from: `@${piece.fill.temp}`, into: [], ...(piece.fill.top !== undefined ? { top: piece.fill.top } : {}) }, ...(p.at ? { at: p.at } : {}) };
          fills.push({ t, target: piece.fill.target, ...(piece.fill.apart ? { apart: true } : {}) });
          made.push(t);
          continue;
        }
        if ("copy" in piece) {
          const at = piece.at ?? p.at;
          const t: Trigger = { label: label(), conds: [], acts: [], copy: { from: piece.copy, into: [], ...(piece.top !== undefined ? { top: piece.top } : {}) }, ...(at ? { at } : {}) };
          if (piece.island) afterIslands.add(t);
          made.push(t);
          continue;
        }
        if ("island" in piece) {
          made.push({ label: label(), conds: [], acts: [], island: piece.island });
          continue;
        }
        if ("call" in piece) {
          const at = piece.at ?? p.at;
          made.push({ label: label(), conds: [], acts: [], call: { ...piece.call.fn, into: this.placesOf(piece.call.target)[0].dword! }, ...(at ? { at } : {}) });
          continue;
        }
        for (let i = 0; i === 0 || i < piece.acts.length; i += MOST_ACTS) {
          if (i === 0 && piece.acts.length === 0 && made.length) break;
          // (A trigger with conditions keeps its own label, entered through its refreshes when it has any.)
          const t: Trigger = { label: p.conds.length && i === 0 ? p.label : label(), conds: p.conds.length && i === 0 ? p.conds.map((c) => ({ ...c })) : [], acts: [], ...(p.at ? { at: p.at } : {}) };
          piece.acts.slice(i, i + MOST_ACTS).forEach((a, k) => {
            if ("into" in a) {
              at.set(a, { at: t.label, field: { act: k, part: "value" } });
              later.push({ t, k, w: a });
              const from = writeOf.get(a as WriteAct)?.at;
              t.acts.push({ dword: { game: 0 }, modifier: a.modifier, value: a.value, ...(from && from !== t.at ? { at: from } : {}) });
            } else t.acts.push(a);
          });
          made.push(t);
        }
      }
      // A copy goes on to the trigger after it; the others say where they go. The last goes where the proto went.
      const last = made[made.length - 1];
      if (last.copy || last.island || last.call) made.push({ label: `${this.key}.cut${n++}`, conds: [], acts: [] });
      made.forEach((t, i) => {
        if (t.copy) { if (!routes.has(t) && !refreshes.some((r) => r.t === t) && !fills.some((f) => f.t === t)) copies.push({ t, id: t.copy.from }); }
        else if (!t.island && !t.call) t.next = i === made.length - 1 ? to(p.next!) : made[i + 1].label;
      });
      triggers.push(...made);
    }
    // Where each write's action writes, now that every place has its dword.
    const dwordOf = (p: Place): Dword => p.dword ?? at.get(p.act!)!;
    for (const { t, k, w } of later) t.acts[k].dword = dwordOf(w.into);
    // A routed variable's refreshes: the numbers and the conditions' places about to be read.
    for (const { t, places } of refreshes) for (const pl of places) {
      if ("into" in pl) t.copy!.into.push({ dword: at.get(pl)!, add: num(pl.reads!.add, pl.reads!.base), ...(pl.reads!.scale !== 1 ? { scale: pl.reads!.scale } : {}) });
      else t.copy!.into.push({ dword: dwordOf(pl), add: num(pl.add, pl.base), ...(pl.scale !== 1 ? { scale: pl.scale } : {}) });
    }
    // A scratch cell into every place of what reads it (a variable of the emitter's own: its home too); into a routed
    // variable's cell alone, which its places are refreshed from where they are read.
    // A target with no place but its cell has the array's cell read straight into it: no scratch cell, no copy.
    const scratch = new Map<string, Act[]>(), tested = new Map<string, Cond[]>(), routedInto = new Map<string, { dword: Dword }[]>();
    for (const x of triggers) {
      for (const a of x.acts) {
        const temp = "temp" in a.dword ? a.dword.temp : typeof a.value === "object" && "epd" in a.value && "temp" in a.value.epd ? a.value.epd.temp : undefined;
        if (temp !== undefined) scratch.set(temp, [...(scratch.get(temp) ?? []), a]);
      }
      // (A product's or a quotient's scratch cell is also tested as it is worked in, and a variable may be routed into it.)
      for (const c of x.conds) if ("temp" in c.dword) tested.set(c.dword.temp, [...(tested.get(c.dword.temp) ?? []), c]);
      for (const c of x.copy?.into ?? []) if ("temp" in c.dword) routedInto.set(c.dword.temp, [...(routedInto.get(c.dword.temp) ?? []), c]);
    }
    for (const { t, target, apart } of fills) {
      const ps = this.placesOf(target);
      // (`apart`: the scratch cell is worked in while the target is still read — a product of the target — and stays one of its own.)
      if (!apart && ps.length === 1 && ps[0].dword && ps[0].scale === 1 && ps[0].add === 0 && !ps[0].base) {
        const home = ps[0].dword;
        for (const a of scratch.get(t.copy!.from.slice(1)) ?? []) {
          if ("temp" in a.dword) a.dword = home;
          else a.value = { epd: home };
        }
        for (const c of tested.get(t.copy!.from.slice(1)) ?? []) c.dword = home;
        for (const c of routedInto.get(t.copy!.from.slice(1)) ?? []) c.dword = home;
        delete t.copy;
        continue;
      }
      for (const p of routed.has(target) ? ps.slice(0, 1) : ps) t.copy!.into.push({ dword: dwordOf(p), add: num(p.add, p.base), ...(p.scale !== 1 ? { scale: p.scale } : {}) });
    }
    // A copied variable's copies: every place but its cell.
    for (const { t, id } of copies) for (const p of this.placesOf(id).slice(1)) {
      if (p.synced && afterIslands.has(t)) continue;
      t.copy!.into.push({ dword: dwordOf(p), add: num(p.add, p.base), ...(p.scale !== 1 ? { scale: p.scale } : {}) });
    }
    // Every way out of the graph passes one trigger at its end, where the branches that went there are put back.
    const exit = `${this.key}.end`;
    for (const t of triggers) if (t.next === END) t.next = exit;
    for (const t of triggers) for (const a of t.acts) if (typeof a.value === "object" && "label" in a.value && a.value.label === END) a.value = { label: exit };
    triggers.push({ label: exit, conds: [], acts: (this.restores.get(END) ?? []).map((r) => ({ dword: { at: r.branch, field: "next" }, modifier: "set", value: { label: to(r.to) === END ? exit : to(r.to) } })), next: END });
    // Triggers that do nothing dropped (a fill read straight into its target, the one after a copy that ends a proto):
    // what went to one goes where it went. Not the end, nor one whose fields something writes (where a function goes
    // back to).
    const fielded = new Set<string>();
    const fields = (x: unknown): void => {
      if (!x || typeof x !== "object") return;
      if (Array.isArray(x)) { x.forEach(fields); return; }
      const o = x as Record<string, unknown>;
      if (typeof o.at === "string" && "field" in o) fielded.add(o.at);
      for (const v of Object.values(o)) if (v && typeof v === "object") fields(v);
    };
    for (const t of triggers) fields([t.acts, t.conds, t.copy?.into]);
    for (const ps of this.places.values()) for (const p of ps) if (p.dword) fields(p.dword);
    // (A copy, an island or a call has no next pointer: it goes on to the trigger after it, so one that does nothing
    // and goes elsewhere stays after one of those.)
    const on = new Map<string, string>();
    let falls = false;
    triggers.forEach((t, i) => {
      const idle = t.label !== exit && !t.conds.length && !t.acts.length && !t.copy && !t.island && !t.call && !fielded.has(t.label);
      if (idle && (t.next === undefined || !falls)) on.set(t.label, t.next ?? triggers[i + 1].label);
      else falls = t.next === undefined;
    });
    if (on.size) {
      const past = (l: string): string => { while (on.has(l)) l = on.get(l)!; return l; };
      const left = triggers.filter((t) => !on.has(t.label));
      triggers.splice(0, triggers.length, ...left);
      for (const t of triggers) {
        if (typeof t.next === "string") t.next = past(t.next);
        for (const a of t.acts) if (typeof a.value === "object" && "label" in a.value) a.value = { label: past(a.value.label) };
      }
    }
    // What the graph reads that was written before it, copied into its places on the way in.
    const graph: Graph = { entries: [], triggers, ...(this.arrays.size ? { arrays: [...this.arrays].map(([id, stride]) => ({ id, stride })) } : {}) };
    for (const id of entries) for (const p of this.placesOf(id)) {
      // (A routed variable's places are refreshed where they are read.)
      if (routed.has(id)) continue;
      const d = dwordOf(p);
      if (p.synced || ("var" in d && d.var === id && p.add === 0 && p.scale === 1 && !p.base)) continue;
      graph.entries.push({ from: id, into: d, add: num(p.add, p.base), ...(p.scale !== 1 ? { scale: p.scale } : {}) });
    }
    const problems = checkGraph(graph);
    return problems.length ? problems.join("; ") : graph;
  }
}

type CompareOp = "<" | "<=" | ">" | ">=" | "==" | "!=";
const FLIP = { "<": ">", "<=": ">=", ">": "<", ">=": "<=", "==": "==", "!=": "!=" } as const;
const INVERSE = { "<": ">=", "<=": ">", ">": "<=", ">=": "<", "==": "!=", "!=": "==" } as const;
/** A comparison of two numbers as 32 bits. */
const compareU32 = (op: CompareOp, x: number, y: number): boolean => {
  const [a, b] = [u(x), u(y)];
  return op === "<" ? a < b : op === "<=" ? a <= b : op === ">" ? a > b : op === ">=" ? a >= b : op === "==" ? a === b : a !== b;
};
const notZero = (e: NumExpr): BoolExpr => ({ kind: "compare", op: "!=", left: e, right: { kind: "const", value: 0 }, at: { line: 0, column: 0 } as At, label: "" });

/**
 * What is still to be read after each call that may come back, in a function's body (a map of our own keeps no more
 * of `saves` than that on the stack): the variables that some way on from the call reads before it writes them. Worked
 * backwards over the statements — a loop until nothing more comes in, a `break` from what follows its loop, a
 * `continue` from its loop's top, a `return` from its value and where it goes (an inlined call's, on after the call).
 * A call is read from (its arguments) and writes its result, and its parameters unless it is one that may come back:
 * that one takes back after it what it keeps, the parameters it sets among them. What the function it calls does to
 * this one's variables does not count otherwise: a function's variables are its own.
 */
export function liveAfterCalls(body: Stmt[]): Map<Call, Set<string>> {
  const out = new Map<Call, Set<string>>();
  /** What is live where a `break`, a `continue` and a `return` go. */
  type Flow = { brk: Set<string>; cont: Set<string>; ret: Set<string> };
  const union = (...xs: Set<string>[]) => new Set(xs.flatMap((x) => [...x]));
  const reads = (e: unknown) => (e && typeof e === "object" ? readIn(e as NumExpr) : new Set<string>());
  const seq = (list: Stmt[], after: Set<string>, flow: Flow): Set<string> => {
    let live = after;
    for (let i = list.length - 1; i >= 0; i--) live = stmt(list[i], live, flow);
    return live;
  };
  const loop = (test: BoolExpr | undefined, body: Stmt[], update: Stmt[], after: Set<string>, testFirst: boolean, flow: Flow): Set<string> => {
    // The top of a turn: (the test, then) the body, the update, and round again — until nothing more comes in.
    const tested = (top: Set<string>) => union(test ? reads(test) : new Set(), after, top);
    let top = new Set<string>();
    for (;;) {
      const cont = seq(update, testFirst ? tested(top) : tested(top), { ...flow, brk: after, cont: after });
      const next = seq(body, cont, { ...flow, brk: after, cont });
      const grown = [...next].some((id) => !top.has(id));
      top = union(top, next);
      if (!grown) return testFirst ? tested(top) : top;
    }
  };
  const stmt = (s: Stmt, after: Set<string>, flow: Flow): Set<string> => {
    switch (s.kind) {
      case "declare": case "assign": case "assignBool": {
        const target = s.kind === "declare" ? s.decl.id : s.target;
        const live = new Set(after);
        live.delete(target);
        return union(live, reads(s.kind === "declare" ? s.init : s.value));
      }
      case "store": return union(after, reads(s.index), reads(s.value));
      case "call": {
        const c = s.call;
        // (Recorded on every pass of a loop around it: the last is the one that holds.)
        if (c.saves) out.set(c, new Set(after));
        let live = new Set(after);
        if (c.result) live.delete(c.result.decl.id);
        // An inlined call's body where it is: its `return` goes on to what follows the call.
        if (c.fn === undefined) live = seq(c.body, live, { brk: live, cont: live, ret: live });
        // (A call that may come back sets parameters that are this function's own, and takes back after it what it
        // keeps: what was live after it is so before it too.)
        if (!c.saves) for (const p of c.params) live.delete(p.decl.id);
        return union(live, ...c.params.map((p) => reads(p.init)));
      }
      case "return": return union(reads(s.value), flow.ret);
      case "if": return union(reads(s.cond), seq(s.then, after, flow), seq(s.else ?? [], after, flow));
      case "block": return seq(s.body, after, flow);
      case "while": return loop(s.cond, s.body, [], after, true, flow);
      case "for": return loop(s.cond, s.body, s.update, after, true, flow);
      case "do": return loop(s.cond, s.body, [], after, false, flow);
      case "break": return flow.brk;
      case "continue": return flow.cont;
      case "switch": {
        // Each case falls into the next; a break leaves the switch, a continue is the loop's around it. Any case may
        // be where it starts, or none.
        const entries: Set<string>[] = [];
        let live = after;
        for (let i = s.cases.length - 1; i >= 0; i--) entries.push((live = seq(s.cases[i].body, live, { ...flow, brk: after })));
        return union(reads(s.value), after, ...entries);
      }
      case "unrolled": {
        let live = after;
        for (let i = s.iterations.length - 1; i >= 0; i--) live = seq(s.iterations[i], live, { ...flow, brk: after, cont: live });
        return live;
      }
      // (Anything else a map of our own takes reads what it reads and writes nothing of a function's own.)
      default: return union(after, reads(s));
    }
  };
  const none = new Set<string>();
  seq(body, none, { brk: none, cont: none, ret: none });
  return out;
}

/**
 * Every variable a statement may write: what it sets or declares, a call's result and parameters, and what the
 * functions it calls write, all the way down.
 */
function writes(s: Stmt, functions: Map<string, FuncDecl>): Set<string> {
  const out = new Set<string>(), seen = new Set<string>();
  const walk = (x: unknown): void => {
    if (!x || typeof x !== "object") return;
    if (Array.isArray(x)) { x.forEach(walk); return; }
    const o = x as Record<string, unknown>;
    if (typeof o.target === "string") out.add(o.target);
    const d = o.decl as VarDecl | undefined;
    if (d && typeof d === "object" && typeof d.id === "string") out.add(d.id);
    if (o.was && typeof o.was === "object") out.add((o.was as VarDecl).id);
    if (typeof o.fn === "string" && !seen.has(o.fn)) { seen.add(o.fn); walk(functions.get(o.fn)?.body); }
    for (const v of Object.values(o)) if (v && typeof v === "object") walk(v);
  };
  walk(s);
  return out;
}

/** Whether a statement may store into an array: itself, or a function it calls, all the way down. */
function stores(s: Stmt, functions: Map<string, FuncDecl>): boolean {
  const seen = new Set<string>();
  const walk = (x: unknown): boolean => {
    if (!x || typeof x !== "object") return false;
    if (Array.isArray(x)) return x.some(walk);
    const o = x as Record<string, unknown>;
    if (o.kind === "store" || o.kind === "declareArray" || o.kind === "push" || o.kind === "pop" || o.kind === "setLength") return true;
    if (typeof o.fn === "string" && !seen.has(o.fn)) { seen.add(o.fn); if (walk(functions.get(o.fn)?.body)) return true; }
    return Object.values(o).some((v) => v && typeof v === "object" && walk(v));
  };
  return walk(s);
}

/** Every variable a statement sets or declares, those inside it included. */
function writtenIn(list: Stmt[], into = new Set<string>()): Set<string> {
  for (const s of list) {
    if (s.kind === "assign") into.add(s.target);
    else if (s.kind === "declare") into.add(s.decl.id);
    for (const v of Object.values(s)) if (Array.isArray(v) && v.length && typeof v[0] === "object" && v[0] && "kind" in v[0]) writtenIn(v as Stmt[], into);
  }
  return into;
}

/** Whether a value or a test reads a cell of an array. */
function readsCell(x: unknown): boolean {
  if (!x || typeof x !== "object") return false;
  if (Array.isArray(x)) return x.some(readsCell);
  const o = x as Record<string, unknown>;
  return o.kind === "element" || Object.values(o).some((v) => v && typeof v === "object" && readsCell(v));
}

/** Every variable a test reads. */
function readIn(e: BoolExpr | NumExpr, into = new Set<string>()): Set<string> {
  if (e.kind === "var") into.add(e.id);
  for (const v of Object.values(e)) {
    if (Array.isArray(v)) v.forEach((x) => x && typeof x === "object" && "kind" in x && readIn(x as BoolExpr, into));
    else if (v && typeof v === "object" && "kind" in v) readIn(v as BoolExpr, into);
  }
  return into;
}

/** A loop's test as what can be tested once (every part of an `and` that reads nothing the loop writes) and the rest. */
function split(cond: BoolExpr, written: Set<string>): { once: BoolExpr | null; every: BoolExpr | null } {
  const c = cond.kind === "compare" ? plain(cond) : cond;
  if (c.kind !== "and") return { once: null, every: c };
  // (A part that reads a cell of an array is tested every turn: what the loop stores is no variable it writes.)
  const fixed = c.items.filter((x) => !readsCell(x) && [...readIn(x)].every((id) => !written.has(id)));
  const rest = c.items.filter((x) => !fixed.includes(x));
  const all = (items: BoolExpr[]): BoolExpr | null => (items.length === 0 ? null : items.length === 1 ? items[0] : { kind: "and", items });
  return { once: all(fixed), every: all(rest) };
}

/**
 * A comparison of a `u32` with a signed number, as two of one reading: a signed number below zero is below every
 * `u32`, so `x < y` with x the `u32` is `y >= 0 && x < y` read from 0 up, `x > y` is `y < 0 || x > y`, and so on.
 */
function plain(e: Extract<BoolExpr, { kind: "compare" }>): BoolExpr {
  if (e.unsigned !== "left" && e.unsigned !== "right") return e;
  const signedSide = e.unsigned === "left" ? e.right : e.left;
  const zero: NumExpr = { kind: "const", value: 0 };
  const negative: BoolExpr = { ...e, op: "<", left: signedSide, right: zero, unsigned: false };
  const notNegative: BoolExpr = { ...e, op: ">=", left: signedSide, right: zero, unsigned: false };
  const asU32: BoolExpr = { ...e, unsigned: true };
  // Which way the signed side being below zero settles it: for "left" (the right side signed) the left is the larger.
  const leftLarger = e.unsigned === "left";
  const holdsWhenNegative = e.op === "!=" || (leftLarger ? e.op === ">" || e.op === ">=" : e.op === "<" || e.op === "<=");
  return holdsWhenNegative ? { kind: "or", items: [negative, asU32] } : { kind: "and", items: [notNegative, asU32] };
}

/**
 * An ordered comparison, read signed, of a variable's bits under a mask that has the sign bit, against a constant —
 * as comparisons read from 0 up: with the sign bit set the bits are below zero (a constant below zero is then compared
 * with them from 0 up, one at zero or above is above them), with it clear they are at or above zero. Null when it is
 * not one.
 */
function signedMask(e: Extract<BoolExpr, { kind: "compare" }>): BoolExpr | null {
  if (e.unsigned === true || e.unsigned === "left" || e.unsigned === "right" || e.op === "==" || e.op === "!=") return null;
  let [l, r, op] = [side(e.left), side(e.right), e.op] as [Side | null, Side | null, CompareOp];
  if (l && "k" in l && r && "mask" in r && r.mask !== undefined) [l, r, op] = [r, l, FLIP[op] as CompareOp];
  if (!l || !r || !("mask" in l) || l.mask === undefined || l.mask < SIGN || !("k" in r)) return null;
  const k = r.k | 0;
  const where = { at: e.at, label: e.label };
  const bits: NumExpr = { kind: "binary", op: "&", left: { kind: "var", id: l.id }, right: { kind: "const", value: l.mask }, at: e.at, label: "" };
  const top: NumExpr = { kind: "binary", op: "&", left: { kind: "var", id: l.id }, right: { kind: "const", value: SIGN }, at: e.at, label: "" };
  const zero: NumExpr = { kind: "const", value: 0 };
  const below: BoolExpr = { kind: "compare", op: "!=", left: top, right: zero, unsigned: true, ...where };
  const above: BoolExpr = { kind: "compare", op: "==", left: top, right: zero, unsigned: true, ...where };
  const asU32: BoolExpr = { kind: "compare", op, left: bits, right: { kind: "const", value: u(k) }, unsigned: true, ...where };
  const less = op === "<" || op === "<=";
  // With the sign bit set: a constant below zero is compared from 0 up; one at zero or above settles it.
  const neg: BoolExpr = k < 0 ? asU32 : { kind: "const", value: less };
  // With it clear: one at zero or above is compared from 0 up; one below zero settles it.
  const pos: BoolExpr = k >= 0 ? asU32 : { kind: "const", value: !less };
  return { kind: "or", items: [{ kind: "and", items: [below, neg] }, { kind: "and", items: [above, pos] }] };
}

/** A variable the rewriter made (`@t…`): the emitter's own, with no cell on the Python side. */
const isTemp = (id: string) => id.startsWith("@t");

/** Whether a value is a test (true or false) and nothing a number could be. */
const isTest = (e: NumExpr | BoolExpr): boolean => e.kind === "compare" || e.kind === "and" || e.kind === "or" || e.kind === "not" || e.kind === "test";

/** Whether a value calls a function anywhere in it. */
function holdsCall(x: unknown): boolean {
  if (!x || typeof x !== "object") return false;
  if (Array.isArray(x)) return x.some(holdsCall);
  const o = x as Record<string, unknown>;
  return o.kind === "call" || Object.values(o).some(holdsCall);
}

/**
 * A loop's statements as the emitter takes them: a value that is `?:`, `Math.abs`, `Math.min` / `max` as `if` / `else`
 * of plain assignments (`x = c ? a : b` is `if (c) x = a; else x = b`; `x = abs(e)` tests e's sign; a product or
 * quotient's abs tests the result's), such a value inside a sum or a comparison's side computed first into a variable
 * of the emitter's own (`@t…`), and a loop's test that needs that computed at the top of each turn. Every expression
 * moved is pure, so computing it ahead of a test that would have skipped it changes nothing. A statement whose
 * rewriting the emitter would not take whole stays as it was (an island cannot read a variable of the emitter's own).
 *
 * For a map of our own (`own`), a call inside an expression becomes a statement of its own ahead of it, the
 * expression reading the call's result: a value to its left that the call may change is taken into a variable of the
 * emitter's own first (JavaScript reads it before the call), and a call in a later part of `&&` / `||` runs only when
 * the parts before it leave the answer open.
 */
class Rewriter {
  n = 0;
  readonly key: string;
  readonly take: (list: Stmt[]) => boolean;
  /** A map of our own (`emitBody`): calls taken out of expressions, and every rewriting taken (there are no islands). */
  readonly own: boolean;
  readonly functions: Map<string, FuncDecl>;
  /** The program's arrays (a map of our own): which of them are kept in regions, whose cells a condition reads. */
  arrays = new Map<string, ArrayDecl>();
  /** What a `return` gives back where it stands: the kind of the function or inlined call around it, innermost last. */
  returning: string[] = [];
  constructor(key: string, take: (list: Stmt[]) => boolean, own = false, functions = new Map<string, FuncDecl>(), result?: string) {
    this.key = key;
    this.take = take;
    this.own = own;
    this.functions = functions;
    if (result) this.returning.push(result);
  }

  /**
   * A value worked out before the statements `pre` gained from `mark` on, and read after them: taken into a variable of
   * the emitter's own at `mark` when a call among them may write what it reads.
   */
  before<E extends NumExpr | BoolExpr>(e: E, pre: Stmt[], mark: number, where: { at: At; label: string }, test = false): E {
    if (!this.own || mark === pre.length || e.kind === "const") return e;
    const after: Stmt = { kind: "block", body: pre.slice(mark), at: where.at };
    const later = writes(after, this.functions);
    // (A cell it reads, when what comes after may store into an array: JavaScript reads it first.)
    if (![...readIn(e)].some((id) => later.has(id)) && !(readsCell(e) && stores(after, this.functions))) return e;
    const t = this.temp();
    pre.splice(mark, 0, test ? { kind: "assignBool", target: t, value: e as BoolExpr, ...where } : { kind: "assign", target: t, value: e as NumExpr, ...where });
    return { kind: "var", id: t } as E;
  }

  /** A call as a statement of its own, after what its arguments need (in `pre`); an inlined call's body rewritten. */
  call(c: Call, pre: Stmt[], where: { at: At; label: string }): void {
    const marks: number[] = [];
    const inits = c.params.map((p) => {
      marks.push(pre.length);
      if (p.decl.kind === "boolean") return this.cond(p.init as BoolExpr, pre, where);
      if (p.decl.kind !== "number") return p.init;
      // (More than a sum — a cell of an array — into a variable of the emitter's own first.)
      const flat = this.flat(p.init as NumExpr, pre, where);
      return linear(flat) ? flat : this.side(flat, pre, where);
    });
    marks.push(pre.length);
    // Each argument read before what the ones after it run (from the last back: a value put in ahead of a later one's
    // statements leaves the earlier marks where they were).
    for (let i = inits.length - 2; i >= 0; i--) {
      const kind = c.params[i].decl.kind;
      if (kind === "number" || kind === "boolean") inits[i] = this.before(inits[i] as NumExpr | BoolExpr, pre, marks[i + 1], where, kind === "boolean");
    }
    this.returning.push(c.result?.kind ?? "void");
    const body = c.fn === undefined ? this.stmts(c.body) : c.body;
    this.returning.pop();
    pre.push({ kind: "call", call: { ...c, params: c.params.map((p, i) => ({ ...p, init: inits[i] })), body }, ...where });
  }

  temp(): string {
    return `@t${this.key}.${this.n++}`;
  }

  at(s: { at?: At; label?: string }) {
    return { at: s.at as At, label: s.label ?? "" };
  }

  /**
   * The loop being rewritten, while its body is: what it may write (its own stores and declarations, those of the
   * functions it calls), and the values computed once on the way in.
   */
  hoist: { written: Set<string>; arrays: Set<string>; out: Stmt[] } | null = null;

  /**
   * A value worth computing once, ahead of the loop, and that may be: a shift, a fixed-point product or quotient, a cell
   * of a list known when the map is built — reading nothing the loop writes, and calling nothing.
   */
  invariant(e: NumExpr): boolean {
    const h = this.hoist;
    if (!h) return false;
    const costly = (e.kind === "binary" && (e.op === ">>" || e.op === ">>>") && e.right.kind === "const") || (e.kind === "intrinsic" && (e.name === "fmul" || e.name === "fdiv")) || e.kind === "element";
    if (!costly) return false;
    let pure = true;
    const walk = (x: unknown): void => {
      if (!pure || !x || typeof x !== "object") return;
      if (Array.isArray(x)) { x.forEach(walk); return; }
      const o = x as Record<string, unknown>;
      if (o.kind === "var" && typeof o.id === "string" && (h.written.has(o.id) || isTemp(o.id))) pure = false;
      if (o.kind === "element" && h.arrays.has(o.array as string)) pure = false;
      if (o.kind === "call" || o.kind === "read" || o.kind === "randomInt" || o.kind === "input" || o.kind === "unitField" || o.kind === "tableRead" || o.kind === "pop") pure = false;
      Object.values(o).forEach(walk);
    };
    walk(e);
    return pure;
  }

  /** Inside a later part of `&&` or `||`, whose reads go ahead of the parts before it (`ahead`). */
  early = 0;
  ahead<X>(f: () => X): X {
    this.early++;
    try {
      return f();
    } finally {
      this.early--;
    }
  }
  /** An index as it is, or — read ahead of what decides whether it is read — without its range, so that it is tested. */
  unsure(index: NumExpr): NumExpr {
    if (!this.early || !("range" in index)) return index;
    const { range: _, ...rest } = index as NumExpr & { range?: unknown };
    return rest as NumExpr;
  }

  /** `e` with every `?:`, abs, min and max in it computed first into a variable of the emitter's own. */
  flat(e: NumExpr, pre: Stmt[], where: { at: At; label: string }): NumExpr {
    if (this.invariant(e)) {
      const t = this.temp();
      // (Computed once, ahead of the loop; the rest of this rewriting sees a variable.)
      const h = this.hoist!;
      this.hoist = null;
      try {
        // (Ahead of the loop, and of any test in it that a range of an index knows from.)
        h.out.push(...this.ahead(() => this.set(t, e, where)));
      } finally {
        this.hoist = h;
      }
      return { kind: "var", id: t };
    }
    switch (e.kind) {
      case "binary": {
        const left = this.flat(e.left, pre, where), mark = pre.length;
        const right = this.flat(e.right, pre, where);
        return { ...e, left: this.before(left, pre, mark, where), right };
      }
      case "unary": case "cast": return { ...e, expr: this.flat(e.expr, pre, where) };
      case "element": return { ...e, index: this.unsure(this.flat(e.index, pre, where)) };
      case "call": {
        if (!this.own || !e.call.result) return e;
        this.call(e.call, pre, where);
        return { kind: "var", id: e.call.result.decl.id };
      }
      case "ternary": case "intrinsic": {
        if (e.kind === "intrinsic" && e.name !== "abs" && e.name !== "min" && e.name !== "max") return { ...e, args: this.each(e.args, pre, where) };
        const t = this.temp();
        pre.push(...this.set(t, e, where));
        return { kind: "var", id: t };
      }
      default: return e;
    }
  }

  /** Several values in order, each flattened: an earlier one read before a later one's calls run. */
  each(list: NumExpr[], pre: Stmt[], where: { at: At; label: string }, as = (e: NumExpr) => e): NumExpr[] {
    const marks: number[] = [];
    const out = list.map((x) => {
      marks.push(pre.length);
      return as(this.flat(x, pre, where));
    });
    marks.push(pre.length);
    for (let i = out.length - 2; i >= 0; i--) out[i] = this.before(out[i], pre, marks[i + 1], where);
    return out;
  }

  /** The statements that set `target` to `e`. */
  set(target: string, e: NumExpr, where: { at: At; label: string }): Stmt[] {
    const assign = (value: NumExpr): Stmt => ({ kind: "assign", target, value, ...where });
    const v = (id: string): NumExpr => ({ kind: "var", id });
    const zero: NumExpr = { kind: "const", value: 0 };
    const pre: Stmt[] = [];
    if (e.kind === "ternary") {
      const cond = this.cond(e.cond, pre, where);
      return [...pre, { kind: "if", cond, then: this.set(target, e.whenTrue, where), else: this.set(target, e.whenFalse, where), ...where }];
    }
    if (e.kind === "intrinsic" && e.name === "abs") {
      let a = this.flat(e.args[0], pre, where);
      // (A map of our own: anything more than a variable plus a constant into a variable of the emitter's own first, so
      // that its sign is one condition, and the target is never set from itself — a variable of the emitter's own
      // cannot be copied, which that would need.)
      if (this.own) a = this.side(a, pre, where);
      if (linear(a)) return [...pre, { kind: "if", cond: { kind: "compare", op: "<", left: a, right: zero, ...where }, then: [assign({ kind: "unary", op: "-", expr: a, at: where.at })], else: [assign(a)], ...where }];
      // (A product or a quotient: into the target first, its sign tested there.)
      return [...pre, assign(a), { kind: "if", cond: { kind: "compare", op: "<", left: v(target), right: zero, ...where }, then: [assign({ kind: "unary", op: "-", expr: v(target), at: where.at })], ...where }];
    }
    if (e.kind === "intrinsic" && (e.name === "min" || e.name === "max") && e.args.length === 2) {
      const [a, b] = this.each(e.args, pre, where, (x) => this.side(x, pre, where));
      const cond: BoolExpr = { kind: "compare", op: e.name === "min" ? "<" : ">", left: a, right: b, ...(e.unsigned ? { unsigned: true } : {}), ...where };
      return [...pre, { kind: "if", cond, then: [assign(a)], else: [assign(b)], ...where }];
    }
    const value = this.flat(e, pre, where);
    return [...pre, assign(value)];
  }

  /** A value the emitter reads cells for as it is (a cell of a list known when the map is built, a shift): left as it is. */
  table(e: NumExpr): boolean {
    return e.kind === "element" || (e.kind === "binary" && (e.op === ">>" || e.op === ">>>"));
  }

  /** A comparison's side as a variable plus a constant: a longer sum computed first. */
  side(e: NumExpr, pre: Stmt[], where: { at: At; label: string }): NumExpr {
    if (side(e)) return e;
    const t = this.temp();
    pre.push(...this.set(t, e, where));
    return { kind: "var", id: t };
  }

  /**
   * A cell of an array a map of our own keeps, compared with a constant, left in the test, where a condition reads it
   * at its index (`Emitter.cellConds`): as 32 bits — a signed comparison as the ranges of bits it holds for, one, or
   * two either side of the sign — after a test that the index is inside the array, unless the value ranges know it is
   * (outside, the cell reads 0). The test stays where it was written, so a range of its index known from the parts of
   * a `&&` before it holds where it is read. Null when it is not that.
   */
  cellCompare(c: Extract<BoolExpr, { kind: "compare" }>, pre: Stmt[], where: { at: At; label: string }): BoolExpr | null {
    if (!this.own || c.unsigned === "left" || c.unsigned === "right") return null;
    const [el, k, op] = c.left.kind === "element" && c.right.kind === "const" ? [c.left, c.right.value, c.op]
      : c.right.kind === "element" && c.left.kind === "const" ? [c.right, c.left.value, FLIP[c.op] as CompareOp] : [null, 0, c.op];
    if (!el || !inRegion(this.arrays, el.array)) return null;
    const a = this.arrays.get(el.array)!;
    const index = this.flat(el.index, pre, where), r = (index as NumExpr & { range?: readonly [number, number] }).range;
    const at = this.side(index, pre, where), cell: NumExpr = { ...el, index: at };
    const raw = (o: CompareOp, v: number): BoolExpr => ({ kind: "compare", op: o, left: cell, right: { kind: "const", value: u(v) }, unsigned: true, ...where });
    const all = (items: BoolExpr[]): BoolExpr => (items.length === 0 ? { kind: "const", value: true } : items.length === 1 ? items[0] : { kind: "and", items });
    // The bits between two numbers, ends included, read as they are.
    const between = (lo: number, hi: number): BoolExpr => all([...(u(lo) > 0 ? [raw(">=", lo)] : []), ...(u(hi) < MAX ? [raw("<=", hi)] : [])]);
    let test: BoolExpr;
    if (c.unsigned === true || op === "==" || op === "!=" || a.kind === "boolean") test = raw(op, k);
    else {
      // (Signed: the numbers it holds for, from the lowest to the highest, as bits — those below zero are above
      // 2147483647 as bits.)
      const K = k | 0, MIN_S = -2147483648, MAX_S = 2147483647;
      const [lo, hi] = op === "<" ? [MIN_S, K - 1] : op === "<=" ? [MIN_S, K] : op === ">" ? [K + 1, MAX_S] : [K, MAX_S];
      test = lo > hi ? { kind: "const", value: false } : lo >= 0 || hi < 0 ? between(lo, hi) : { kind: "or", items: [between(lo, -1), between(0, hi)] };
    }
    if (r && r[0] >= 0 && r[1] < a.length) return test;
    // (What a cell outside reads, 0, against the constant: the index outside is then enough.)
    const holds = (e: BoolExpr): boolean => e.kind === "const" ? e.value : e.kind === "and" ? e.items.every(holds) : e.kind === "or" ? e.items.some(holds)
      : e.kind === "compare" ? compareU32(e.op, 0, (e.right as { value: number }).value) : false;
    const inside: BoolExpr = { kind: "compare", op: "<", left: at, right: { kind: "const", value: a.length }, unsigned: true, ...where };
    const guarded: BoolExpr = { kind: "and", items: [inside, test] };
    return holds(test) ? { kind: "or", items: [{ ...inside, op: ">=" }, guarded] } : guarded;
  }

  cond(c: BoolExpr, pre: Stmt[], where: { at: At; label: string }): BoolExpr {
    switch (c.kind) {
      case "compare": {
        const cell = this.cellCompare(c, pre, where);
        if (cell) return cell;
        const [left, right] = this.each([c.left, c.right], pre, where, (x) => this.side(x, pre, where));
        return { ...c, left, right };
      }
      case "test": return { ...c, expr: this.side(this.flat(c.expr, pre, where), pre, where) };
      case "and": case "or": {
        if (!this.own || !c.items.slice(1).some(holdsCall)) {
          // (A later part's cells are read ahead of the whole, before the parts that decide whether it is read: what a
          // range of its index knows from them does not hold there.)
          return { ...c, items: c.items.map((x, i) => (i === 0 ? this.cond(x, pre, where) : this.ahead(() => this.cond(x, pre, where)))) };
        }
        // A later part calls: it runs only when the parts before it leave the answer open. The answer so far is kept
        // in a variable of the emitter's own, each later part worked out under an `if` on it.
        const t = this.temp(), so: BoolExpr = { kind: "var", id: t };
        const first = this.cond(c.items[0], pre, where);
        pre.push({ kind: "assignBool", target: t, value: first, ...where });
        for (const x of c.items.slice(1)) {
          const inner: Stmt[] = [];
          const value = this.cond(x, inner, where);
          pre.push({ kind: "if", cond: c.kind === "and" ? so : { kind: "not", expr: so }, then: [...inner, { kind: "assignBool", target: t, value, ...where }], ...where });
        }
        return so;
      }
      case "not": return { ...c, expr: this.cond(c.expr, pre, where) };
      case "call": {
        if (!this.own || !c.call.result) return c;
        this.call(c.call, pre, where);
        return { kind: "var", id: c.call.result.decl.id };
      }
      // (A cell of an array of booleans, as a test: read by the condition, or into a variable of the emitter's own first.)
      case "element": {
        if (!this.own) return c;
        const cell = this.cellCompare({ kind: "compare", op: "!=", left: c as NumExpr, right: { kind: "const", value: 0 }, ...where }, pre, where);
        if (cell) return cell;
        const t = this.temp();
        pre.push(...this.set(t, { ...c, index: this.unsure(c.index) } as NumExpr, where));
        return { kind: "var", id: t };
      }
      default: return c;
    }
  }

  /** The statements as the emitter takes them; each one whose rewriting it would not take whole, as it was. */
  stmts(list: Stmt[]): Stmt[] {
    return list.flatMap((s) => this.stmt(s));
  }

  stmt(s: Stmt): Stmt[] {
    const where = this.at(s);
    const keep = (out: Stmt[]) => (this.take(out) ? out : [s]);
    const plain = (e: NumExpr) => !!linear(e);
    switch (s.kind) {
      case "assign": return plain(s.value) ? [s] : keep(this.set(s.target, s.value, where));
      case "declare": {
        if (s.decl.kind === "boolean" && this.own) {
          const pre: Stmt[] = [];
          const init = this.cond(s.init as BoolExpr, pre, where);
          return pre.length ? keep([...pre, { ...s, init }]) : [{ ...s, init }];
        }
        const init = s.init as NumExpr;
        if (s.decl.kind !== "number" || plain(init)) return [s];
        return keep([{ ...s, init: { kind: "const", value: 0 } }, ...this.set(s.decl.id, init, where)]);
      }
      case "block": return [{ ...s, body: this.stmts(s.body) }];
      case "store": {
        // A value the emitter does not take as it is into a variable of its own first; the index likewise. (A map of
        // our own: a test stored into an array of booleans, into a variable of its own as 1 or 0.)
        const pre: Stmt[] = [];
        if (this.own && isTest(s.value)) {
          // (The index first, as JavaScript reads it: the test may call what changes it.)
          let index = plain(s.index) ? s.index : this.side(this.flat(s.index, pre, where), pre, where);
          const mark = pre.length, t = this.temp();
          const value = this.cond(s.value as BoolExpr, pre, where);
          pre.push({ kind: "assignBool", target: t, value, ...where });
          index = this.before(index, pre, mark, where);
          return [...pre, { ...s, index, value: { kind: "var", id: t } }];
        }
        const value = s.value as NumExpr;
        let index = plain(s.index) ? s.index : this.side(this.flat(s.index, pre, where), pre, where);
        const mark = pre.length;
        let stored: NumExpr = value;
        if (!plain(value) && !this.table(value)) {
          const t = this.temp();
          pre.push(...this.set(t, value, where));
          stored = { kind: "var", id: t };
        }
        index = this.before(index, pre, mark, where);
        return pre.length ? keep([...pre, { ...s, index, value: stored }]) : [s];
      }
      case "call": {
        if (!this.own) return [s];
        const pre: Stmt[] = [];
        this.call(s.call, pre, where);
        return pre;
      }
      case "declareArray": {
        // The cells' values, in JavaScript's order; a test as 1 or 0, anything more than a sum, into variables of the
        // emitter's own first.
        const values = [...(s.init ?? []), ...(s.fill !== undefined ? [s.fill] : [])];
        if (!this.own || values.every((v) => !isTest(v) && plain(v as NumExpr))) return [s];
        const pre: Stmt[] = [];
        const nums = values.map((v) => {
          if (!isTest(v)) return v as NumExpr;
          const t = this.temp();
          pre.push({ kind: "assignBool", target: t, value: this.cond(v as BoolExpr, pre, where), ...where });
          return { kind: "var", id: t } as NumExpr;
        });
        const flat = this.each(nums, pre, where, (x) => (plain(x) ? x : this.side(x, pre, where)));
        return [...pre, { ...s, ...(s.init ? { init: flat.slice(0, s.init.length) } : {}), ...(s.fill !== undefined ? { fill: flat[flat.length - 1] } : {}) }];
      }
      case "print": {
        // The values of a printed text, as the emitter takes them and in JavaScript's order: each worked out before a
        // later one's call, a value more than a sum into a variable of the emitter's own first.
        if (!this.own || s.parts.every((p) => (p.kind !== "number" && p.kind !== "char") || plain(p.expr))) return [s];
        const pre: Stmt[] = [];
        const valued = s.parts.filter((p): p is Extract<TextPart, { kind: "number" | "char" }> => p.kind === "number" || p.kind === "char");
        const exprs = this.each(valued.map((p) => p.expr), pre, where, (x) => (plain(x) ? x : this.side(x, pre, where)));
        let i = 0;
        return [...pre, { ...s, parts: s.parts.map((p) => (p.kind === "number" || p.kind === "char" ? { ...p, expr: exprs[i++] } : p)) }];
      }
      case "return": {
        // The value given back, as the emitter takes it: a boolean's test flattened, a number into a variable of the
        // emitter's own first when it is more than a sum.
        const kind = this.returning[this.returning.length - 1];
        if (!this.own || s.value === undefined || (kind !== "number" && kind !== "boolean")) return [s];
        const pre: Stmt[] = [];
        if (kind === "boolean") {
          const value = this.cond(s.value as BoolExpr, pre, where);
          return [...pre, { ...s, value }];
        }
        if (plain(s.value as NumExpr)) return [s];
        const t = this.temp();
        return [...this.set(t, s.value as NumExpr, where), { ...s, value: { kind: "var", id: t } }];
      }
      case "if": {
        const pre: Stmt[] = [];
        const cond = this.cond(s.cond, pre, where);
        const head = pre.length && this.take([...pre]) ? pre : null;
        // (A map of our own takes the test as rewritten, whether or not anything comes before it: a cell compared with a
        // constant is read by the condition itself.)
        const out: Stmt = { ...s, cond: head || this.own ? cond : s.cond, then: this.stmts(s.then), ...(s.else ? { else: this.stmts(s.else) } : {}) };
        return head ? [...head, out] : [out];
      }
      case "while": case "for": {
        const pre: Stmt[] = [];
        const cond = s.cond ? this.cond(s.cond, pre, where) : undefined;
        const body = this.stmts(s.body);
        const update = s.kind === "for" ? this.stmts(s.update) : [];
        if (!pre.length || !this.take([...pre])) {
          const test = this.own ? { cond } : {};
          return [s.kind === "for" ? { ...s, ...test, body, update } : { ...s, ...test, body }];
        }
        // The test needs values computed first: at the top of each turn, before it.
        const leave: Stmt = { kind: "if", cond: { kind: "not", expr: cond! }, then: [{ kind: "break", ...where }], ...where };
        return [s.kind === "for" ? { ...s, cond: undefined, body: [...pre, leave, ...body], update } : { ...s, cond: undefined, body: [...pre, leave, ...body] }];
      }
      case "do": {
        // (A map of our own: the test as rewritten when nothing comes before it — something that did would have to run
        // at a `continue` too.)
        const pre: Stmt[] = [];
        const cond = this.own ? this.cond(s.cond, pre, where) : s.cond;
        return [{ ...s, body: this.stmts(s.body), ...(this.own && !pre.length ? { cond } : {}) }];
      }
      case "unrolled": return [{ ...s, iterations: s.iterations.map((it) => this.stmts(it)) }];
      case "switch": {
        const pre: Stmt[] = [];
        const value = side(s.value) ? s.value : this.side(this.flat(s.value, pre, where), pre, where);
        const out: Stmt = { ...s, value, cases: s.cases.map((c) => ({ ...c, body: this.stmts(c.body) })) };
        return pre.length && this.take([...pre]) ? [...pre, out] : [{ ...s, cases: s.cases.map((c) => ({ ...c, body: this.stmts(c.body) })) }];
      }
      case "assignBool": {
        const pre: Stmt[] = [];
        const value = this.cond(s.value, pre, where);
        return pre.length ? keep([...pre, { ...s, value }]) : [this.own ? { ...s, value } : s];
      }
      default: return [s];
    }
  }
}

/**
 * A statement with the calls of functions that are one `return` of a number put in their place, the parameters
 * replaced by the arguments: `cellAt(mapX, mapY)` is `CELLS[mapY * SIZE + mapX]`. Only where every argument is a sum
 * the emitter lowers (reading it twice is reading it once); the function itself stays, for its other calls.
 */
function inlined(x: unknown, functions: Map<string, FuncDecl>, depth = 0): unknown {
  if (Array.isArray(x)) return x.map((y) => inlined(y, functions, depth));
  if (!x || typeof x !== "object") return x;
  const o = x as Record<string, unknown>;
  if (o.kind === "call" && !("label" in o) && depth < 4) {
    const c = (o as Extract<NumExpr, { kind: "call" }>).call;
    // A called function's body, or (a function called once) the body the call carries.
    const f = c.fn ? functions.get(c.fn) : undefined;
    const body = (f ? f.body : c.fn ? undefined : c.body)?.filter((st) => st.kind !== "remark");
    const params = f ? f.params : c.params.map((p) => p.decl);
    const ret = body?.length === 1 && body[0].kind === "return" ? body[0].value : undefined;
    if (ret && c.result?.kind === "number" && params.length === c.params.length && params.every((p) => p.kind === "number" && !p.bits) && c.params.every((p) => linear(p.init as NumExpr))) {
      const by = new Map(c.params.map((p) => [p.decl.id, p.init as NumExpr]));
      const put = (e: unknown): unknown => {
        if (Array.isArray(e)) return e.map(put);
        if (!e || typeof e !== "object") return e;
        const v = e as Record<string, unknown>;
        if (v.kind === "var" && by.has(v.id as string)) return by.get(v.id as string);
        return Object.fromEntries(Object.entries(v).map(([k, w]) => [k, put(w)]));
      };
      return inlined(put(ret), functions, depth + 1);
    }
  }
  return Object.fromEntries(Object.entries(o).map(([k, v]) => [k, inlined(v, functions, depth)]));
}

/**
 * A function's number kept as a value (`fn` on a constant) as a plain number: in a map of our own nothing else keeps
 * the function in the map — the dispatcher's call of it lays it out.
 */
function plainFns(x: unknown): unknown {
  if (Array.isArray(x)) return x.map(plainFns);
  if (!x || typeof x !== "object") return x;
  const o = x as Record<string, unknown>;
  if (o.kind === "const" && "fn" in o) {
    const plain = { ...o };
    delete plain.fn;
    return plain;
  }
  return Object.fromEntries(Object.entries(o).map(([k, v]) => [k, plainFns(v)]));
}

/**
 * The loops the emitter takes, replaced by `graph` statements: `{ kind: "graph", graph, original }`. Returns how many
 * it took. A per-player program is not looked at yet (its variables are rows), nor a task's (its variables are slots).
 */
/** How often the emitter did what is worth counting, for its tests: loops with values computed once on the way in. */
export const emitterCounts = { hoisted: 0, reciprocals: 0, jumps: 0, products: 0, quotients: 0 };

/**
 * A whole body of statements lowered to one graph, for a map of our own (no Python side, no eudplib): every statement
 * must be the emitter's — a print of a known text is the game's Display Text — with nothing left to an island, no
 * call of a function of the Python side's, and nothing read that the body did not write first (there is no one to
 * copy it in; a copy within the body is made of triggers by the layout). Returns the graph, or why it cannot be.
 */
export function emitBody(body: Stmt[], decls: Map<string, VarDecl>, key: string, functions = new Map<string, FuncDecl>(), arrays = new Map<string, ArrayDecl>(), stackDepth = STACK_DEPTH, owner?: number): Graph | string {
  // (Every statement must be the emitter's here, so a rewriting it would not take is refused whichever way it goes:
  // no trial is needed.)
  const take = () => true;
  const known = new Map(decls);
  for (const f of functions.values()) {
    for (const p of f.params) known.set(p.id, p);
    if (f.result) known.set(f.result.decl.id, f.result.decl);
  }
  // A called function's body, rewritten once, the first time a call reaches it (a call of itself meanwhile sees it as
  // it was written, and is refused).
  const bodies = new Map<string, Stmt[]>();
  const bodyOf = (id: string): Stmt[] | undefined => {
    const f = functions.get(id);
    if (!f) return undefined;
    let b = bodies.get(id);
    if (!b) {
      bodies.set(id, f.body);
      const rw = new Rewriter(`${key}.f${bodies.size}`, take, true, functions, f.result?.kind);
      rw.arrays = arrays;
      b = rw.stmts(plainFns(inlined(f.body, functions)) as Stmt[]);
      bodies.set(id, b);
    }
    return b;
  };
  const rules = (scope: Scope) => {
    scope.native = true;
    scope.owner = owner;
    scope.functions = functions;
    scope.arrays = arrays;
    scope.bodyOf = bodyOf;
  };
  const rw = new Rewriter(key, take, true, functions);
  rw.arrays = arrays;
  const block = rw.stmt(plainFns(inlined({ kind: "block", body, at: body[0]?.at } as Stmt, functions)) as Stmt);
  const s: Stmt = block.length === 1 ? block[0] : ({ kind: "block", body: block, at: body[0]?.at } as Stmt);
  const scope = new Scope(known);
  rules(scope);
  if (!scope.stmt(s, false)) return scope.why || "?";
  if (scope.islands.size) {
    // (The first that holds a part the emitter never takes, before one refused for how it is put together — a print to
    // all players the front end adds, say, after a closure it cannot keep.)
    const refused = [...scope.islands.keys()];
    const first = refused.find((s) => scope.whyOf.get(s)?.never) ?? refused[0];
    return `${scope.whyOf.get(first)?.why || `a ${first.kind} it does not lower`}${first.at ? `, line ${first.at.line}` : ""}`;
  }
  if (scope.calls.size) {
    const [s, call] = [...scope.calls][0];
    return `a ${call.fn.fn.startsWith("fdiv") ? "quotient" : "product"} of fixed numbers${s.at ? `, line ${s.at.line}` : ""}`;
  }
  const make = (forced: Set<string>): { e: Emitter; g: Graph | string } => {
    const e = new Emitter(key, scope);
    e.forced = forced;
    e.stackDepth = stackDepth;
    // Stacks: each `sp` and `depth` set at the start, which sets every place of each `sp` — the fields of its stack it
    // addresses. (Which stacks there are is known once the functions are laid out: the writes go into this trigger then.)
    const start = scope.recursion ? e.push({ conds: [], items: [] }) : null;
    e.stmt(s);
    // At its end the program wakes no more.
    e.open().items.push({ act: { dword: { data: WAKE_TICK }, modifier: "set", value: U32 - 1 } });
    e.goto(END);
    e.functions();
    e.emitDigits();
    if (start) {
      const writes: Write[] = [...[...e.stacks.values()].map((st) => st.sp), ...(e.stacks.size ? [e.depth] : [])].map((target) => ({ target, value: { c: 0, terms: [] } }));
      start.items.unshift(...writes.map((write) => ({ write })));
      for (const w of writes) e.writes.set(w.target, [...(e.writes.get(w.target) ?? []), w]);
    }
    const g = e.graph([...scope.read].filter((id) => !scope.declared.has(id) && !isTemp(id)));
    if (typeof g !== "string" && e.stacks.size) {
      const most = Math.max(...[...e.stacks.values()].map((st) => st.frame)), cells = [...e.stacks.values()].reduce((n, st) => n + st.frame * e.stackDepth, 0);
      if (most > MOST_ACTS) return { e, g: `a function that calls itself and keeps ${most - 1} variables around a call (${MOST_ACTS - 1} at the most)` };
      if (cells > STACK_CELLS_MOST) return { e, g: `stacks of ${cells} cells (${e.stackDepth} calls deep, ${cells / e.stackDepth} cells for a call of each function that calls itself), past the ${STACK_CELLS_MOST} a map of our own lays out: lower the recursion depth in the script's settings` };
      g.cells = [...(g.cells ?? []), ...[...e.stacks.values()].map((st) => ({ id: st.id, cells: st.frame * e.stackDepth }))];
    }
    if (typeof g !== "string" && e.templates.length) g.templates = e.templates;
    if (typeof g !== "string" && e.regions.size) g.cells = [...e.regions.values(), ...(g.cells ?? [])];
    const cells = typeof g === "string" ? 0 : (g.cells ?? []).reduce((n, r) => n + r.cells, 0);
    if (cells > STACK_CELLS_MOST) return { e, g: `arrays and stacks of ${cells} cells, past the ${STACK_CELLS_MOST} a map of our own lays out (72 bytes a cell)` };
    return { e, g };
  };
  const g = make(new Set()).g;
  if (typeof g === "string") return g;
  if (g.entries.length) return `${g.entries[0].from} is read before the body writes it`;
  if (g.triggers.some((t) => t.island || t.call)) return "an island or a call";
  return g;
}

/** One loop lowered to a graph, or why it is not. `decls`: every variable of the program, by id. */
export function emitLoop(loop: Stmt, decls: Map<string, VarDecl>, key: string, functions = new Map<string, FuncDecl>(), indexed = new Set<string>(), arrays = new Map<string, ArrayDecl>()): Graph | string {
  const scope = new Scope(decls);
  scope.functions = functions;
  scope.indexed = indexed;
  scope.arrays = arrays;
  // (The loop the graph is made from, with calls put in their place and its values rewritten into what the emitter
  // takes; `original` stays the loop as written.)
  const take = (list: Stmt[]): boolean => {
    const trial = new Scope(decls);
    trial.functions = functions;
    trial.indexed = indexed;
    trial.arrays = arrays;
    return trial.stmts(list, true) && trial.islands.size === 0;
  };
  const rw = new Rewriter(key, take);
  const shaped = inlined(loop, functions) as Stmt;
  // What of the loop's values reads nothing it writes is computed once, on the way in.
  const stored = new Set<string>(), seen = new Set<string>();
  const storesIn = (x: unknown): void => {
    if (!x || typeof x !== "object") return;
    if (Array.isArray(x)) { x.forEach(storesIn); return; }
    const o = x as Record<string, unknown>;
    if ((o.kind === "store" || o.kind === "push" || o.kind === "setLength" || o.kind === "pop" || o.kind === "declareArray") && typeof o.array === "string") stored.add(o.array);
    // (A function that calls itself, or two that call each other, looked into once.)
    if (typeof o.fn === "string" && !seen.has(o.fn)) {
      seen.add(o.fn);
      storesIn(functions.get(o.fn)?.body);
    }
    Object.values(o).forEach(storesIn);
  };
  storesIn(shaped);
  rw.hoist = { written: writes(shaped, functions), arrays: stored, out: [] };
  let rewritten = rw.stmt(shaped)[0];
  const hoisted = rw.hoist.out;
  rw.hoist = null;
  // (What is computed ahead must be the emitter's own whole, or the loop is rewritten again computing it where it was.)
  if (hoisted.length && !take(hoisted)) rewritten = new Rewriter(`${key}r`, take).stmt(shaped)[0];
  if (rewritten.kind !== "while" && rewritten.kind !== "for" && rewritten.kind !== "do" && rewritten.kind !== "unrolled") return "not a loop";
  const s: Stmt = hoisted.length && take(hoisted) ? { kind: "block", body: [...hoisted, rewritten], at: rewritten.at } : rewritten;
  if (s.kind === "block") emitterCounts.hoisted++;
  if (!scope.stmt(s, false) || scope.islands.has(s) || scope.islands.has(rewritten)) return scope.why || "?";
  // A loop that is all islands is the Python side's still.
  if (scope.read.size === 0 && scope.written.size === 0) return "nothing in it the emitter lowers";
  const make = (forced: Set<string>): { e: Emitter; g: Graph | string } => {
    const e = new Emitter(key, scope);
    e.forced = forced;
    e.stmt(s);
    e.goto(END);
    return { e, g: e.graph([...scope.read].filter((id) => !scope.declared.has(id) && !isTemp(id))) };
  };
  const first = make(new Set());
  if (first.g !== "crowded") return first.g;
  // A cell's target in more places than one trigger's actions: once more, that target copied after its reads — or,
  // for a variable of the emitter's own (which has no cell on the Python side to copy from), the variables read from it.
  const forced = new Set<string>();
  for (const id of first.e.crowded) {
    if (!first.e.own.has(id) && !isTemp(id)) forced.add(id);
    else for (const [target, ws] of first.e.writes) if (ws.some((w) => w.value.terms.some((t) => t.id === id))) forced.add(target);
  }
  return make(forced).g;
}

export function emitGraphs(program: Program, report?: (line: string) => void): number {
  if ((program as Program & { perPlayer?: boolean }).perPlayer) return 0;
  const decls = new Map<string, VarDecl>();
  const collect = (x: unknown): void => {
    if (Array.isArray(x)) x.forEach(collect);
    else if (x && typeof x === "object") {
      const o = x as Record<string, unknown>;
      if (o.decl && typeof o.decl === "object" && "id" in (o.decl as object)) decls.set((o.decl as VarDecl).id, o.decl as VarDecl);
      for (const v of Object.values(o)) if (v && typeof v === "object") collect(v);
    }
  };
  collect(program);
  const functions = new Map((program.functions ?? []).map((f) => [f.id, f] as [string, FuncDecl]));
  const arrays = new Map(program.arrays.map((a) => [a.id, a] as [string, ArrayDecl]));
  const indexed = new Set<string>();
  const indexes = (x: unknown): void => {
    if (!x || typeof x !== "object") return;
    if (Array.isArray(x)) { x.forEach(indexes); return; }
    const o = x as Record<string, unknown>;
    if ((o.kind === "element" || o.kind === "store") && o.index && typeof o.index === "object" && (o.index as NumExpr).kind === "var") indexed.add((o.index as { id: string }).id);
    for (const v of Object.values(o)) if (v && typeof v === "object") indexes(v);
  };
  indexes(program);
  let taken = 0;
  const visit = (list: Stmt[]): void => {
    for (let i = 0; i < list.length; i++) {
      const s = list[i];
      if (s.kind === "while" || s.kind === "for" || s.kind === "do" || s.kind === "unrolled") {
        const g = emitLoop(s, decls, `g${taken}`, functions, indexed, arrays);
        if (typeof g === "string") report?.(`emitter: left the loop at line ${s.at?.line}: ${g}`);
        else {
          {
            list[i] = { kind: "graph", graph: g, original: [s], at: s.at, label: s.label } as unknown as Stmt;
            report?.(`emitter: took the loop at line ${s.at?.line}: ${g.triggers.length} triggers, ${g.entries.length} copies on the way in`);
            taken++;
            continue;
          }
        }
      }
      for (const v of Object.values(s)) {
        if (Array.isArray(v) && v.length && typeof v[0] === "object" && v[0] && "kind" in v[0]) visit(v as Stmt[]);
      }
    }
  };
  visit(program.body);
  for (const f of program.functions ?? []) visit(f.body);
  return taken;
}
