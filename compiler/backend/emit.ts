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
import type { ArrayDecl, BoolExpr, FuncDecl, NumExpr, Program, Stmt, VarDecl, At } from "../ir";
import { PACK_FROM } from "../eud";
import { END, MOST_ACTS, MOST_CONDS, checkGraph, type Act, type Compare, type Cond, type Dword, type FixedFn, type Graph, type Num, type Trigger } from "./graph";

const U32 = 2 ** 32;
const SIGN = 2 ** 31;
const MAX = U32 - 1;
const u = (n: number) => ((n % U32) + U32) % U32;

/** a × b, wrapping at 32 bits, both read from 0 up. */
const mul = (a: number, b: number) => u(Math.imul(a, b));

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

function linear(e: NumExpr, cell?: (e: Extract<NumExpr, { kind: "element" | "binary" }>) => string | null): Linear | null {
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

// ── what the emitter takes ──

class Scope {
  /** Every variable a taken statement reads or writes, and those it declares. */
  read = new Set<string>();
  written = new Set<string>();
  declared = new Set<string>();
  /** Why the last statement looked at was not taken. */
  why = "";
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
  tables = new Map<Stmt, { reads: { id: string; table?: Table; shift?: Shift }[]; value: Linear }>();
  cells = 0;
  /** The statements whose value is a fixed-point product or quotient the graph calls the Python side's function for. */
  calls = new Map<Stmt, { fn: FixedFn; args: Linear[] }>();
  /** The stores into cells of the program's arrays the emitter makes: the array, the index, the value (cells first). */
  stores = new Map<Stmt, Store>();

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
  withCells(e: NumExpr): { reads: { id: string; table?: Table; shift?: Shift }[]; value: Linear } | null {
    const reads: { id: string; table?: Table; shift?: Shift }[] = [];
    const value = linear(e, (el) => {
      if (el.kind === "element") {
        const t = this.table(el);
        if (!t) return null;
        const id = `@cell${this.cells++}`;
        reads.push({ id, table: t });
        return id;
      }
      const of = linear(el.left), by = linear(el.right);
      if (!of || !by || by.terms.length || by.c < 1 || by.c > 31 || !of.terms.every((t) => this.ok(t.id))) return null;
      const id = `@cell${this.cells++}`;
      reads.push({ id, shift: { of, by: by.c, signed: el.op === ">>" } });
      return id;
    });
    if (!value || !value.terms.every((t) => t.id.startsWith("@cell") || this.ok(t.id))) return null;
    for (const t of [...value.terms, ...reads.flatMap((r) => (r.table ? r.table.index : r.shift!.of).terms)]) if (!t.id.startsWith("@cell")) this.read.add(t.id);
    return { reads, value };
  }

  /**
   * A cell of a list the script computed when it was built (`values`, which nothing writes), at an index the emitter
   * lowers: read where it is, a condition a bit of the values, its address a place of the index. Null otherwise.
   */
  table(e: NumExpr): Table | null {
    if (e.kind !== "element") return null;
    const a = this.arrays.get(e.array) as (ArrayDecl & { packed?: unknown }) | undefined;
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
   * A statement the emitter does not lower, left to the Python side where it is (an *island*): taken when nothing in
   * it leaves it — no `break` or `continue` of a loop outside it, no `return`, no wait — and it reads no array at a
   * `for` loop's counter (the Python side has registers for that, part 2). What it may write is copied back into the
   * places of the graph's after it: its own writes, those of the functions it calls.
   */
  island(s: Stmt): boolean {
    let ok = true;
    // (`loops`: the loops around, inside the statement; `breaks`: those and the switches, which a break also ends.)
    const walk = (x: unknown, loops: number, breaks = loops): void => {
      if (!ok || !x || typeof x !== "object") return;
      if (Array.isArray(x)) { x.forEach((y) => walk(y, loops, breaks)); return; }
      const o = x as Record<string, unknown>;
      switch (o.kind) {
        case "break": if (breaks === 0) ok = this.no("a break out of a statement it cannot lower"); break;
        case "continue": if (loops === 0) ok = this.no("a continue out of a statement it cannot lower"); break;
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
    walk(s, 0);
    if (!ok) return false;
    this.islands.set(s, writes(s, this.functions));
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
        const a = this.arrays.get(s.array);
        if (!a || !storable(a) || this.counters.some((c) => [...readIn(s.index)].some((id) => c.has(id)))) return this.island(s);
        const index = linear(s.index);
        if (!index || !index.terms.every((t) => this.ok(t.id))) return this.island(s);
        const value: { reads: { id: string; table?: Table; shift?: Shift }[]; value: Linear } | null = this.lowers(s.value as NumExpr) ? { reads: [], value: linear(s.value as NumExpr)! } : this.withCells(s.value as NumExpr);
        if (!value) return this.island(s);
        for (const t of [...index.terms, ...value.value.terms]) if (!t.id.startsWith("@cell")) this.read.add(t.id);
        this.stores.set(s, { array: a, index, ...value });
        return true;
      }
      case "break": case "continue": return inLoop;
      default: return this.island(s);
    }
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
interface Table { array: ArrayDecl; index: Linear; jump?: boolean }
/** A sum the emitter lowers shifted right by a constant: `>>` keeps the sign, `>>>` reads from 0 up. */
interface Shift { of: Linear; by: number; signed: boolean }
/** A store into a cell of one of the program's arrays: its index, and its value with the cells it reads first. */
interface Store { array: ArrayDecl; index: Linear; reads: { id: string; table?: Table; shift?: Shift }[]; value: Linear }
/** (`at` on a copy or a call: the statement it is for, when its trigger is another's.) */
type Item = { act: Act } | { write: Write } | { fill: { temp: string; target: string } } | { copy: string; at?: At } | { island: Stmt; writes: Set<string> } | { bump: { target: string; add: number } } | { call: { fn: FixedFn; target: string }; at?: At };
/** `keep`: an empty trigger that stays (a jump whose next pointer a place sets). */
interface Proto { label: string; conds: Cond[]; items: Item[]; next?: string; at?: At; depth?: number; keep?: boolean }

/**
 * A place of a variable: a dword that holds it times `scale` plus `add` (wrapping) — known (its cell, a home, a
 * condition's number) or the number of an action of an expanded write, found when the triggers are cut.
 */
interface Place { dword?: Dword; act?: WriteAct; scale: number; add: number; base?: string; synced?: boolean }

/**
 * The most bits a list's values may have between them for the emitter to read its cells where they are: a trigger a
 * bit, each 13 ns when the bit is clear and 23 when set, against about 200 ns for the Python side's read of a cell.
 */
const TABLE_BITS = 6;

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
  /** The variables a function's result goes into: their cells take it, and a copy fills their other places. */
  results = new Set<string>();
  /** The emitter's own variables that are a function's parameter: their one place is its cell. */
  params = new Map<string, Dword>();
  /** The table targets whose places outgrew a trigger, for the emitter to try again with them copied. */
  crowded = new Set<string>();

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
      this.places.set(id, (p = [{ dword: this.params.get(id) ?? (this.own.has(id) || isTemp(id) ? { data: `${this.key}.v.${id}` } : { var: id }), scale: 1, add: 0 }]));
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
    const t: Proto = { label: p.label ?? this.label("t"), conds: p.conds, items: p.items, next: p.next, at: p.at ?? this.at, depth: this.loops.length, ...(p.keep ? { keep: true } : {}) };
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
    const d = unsigned ? 0 : SIGN;
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
        case "!=": return null;
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
        // != when true, == when false: below, or above.
        this.jump({ ...e, op: "<" }, true, to, at);
        this.jump({ ...e, op: ">" }, true, to, at);
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
      // The cells first, each into a variable of the emitter's own; then the value, a sum of them and the rest.
      const own = new Map(cells.reads.map((r) => [r.id, `${this.key}.${r.id.slice(1)}`]));
      for (const r of cells.reads) {
        this.own.add(own.get(r.id)!);
        if (r.table) this.readTable(own.get(r.id)!, r.table, s.at);
        else this.readShift(own.get(r.id)!, r.shift!, s.at);
      }
      const value = { c: cells.value.c, terms: cells.value.terms.map((t) => ({ id: own.get(t.id) ?? t.id, k: t.k })) };
      return this.write(s.kind === "declare" ? s.decl.id : s.target, value);
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
        const { once, every } = s.cond ? split(s.cond, writtenIn([...s.body, ...(s.kind === "for" ? s.update : [])])) : { once: null, every: null };
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
    for (let top = 31; top >= sh.by; top -= 8) {
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

  /**
   * A store into a cell of an array: one trigger, its condition the index inside the array (read from 0 up: one below
   * zero is past the end, where a store does nothing), its action setting the cell — the action's destination a place
   * of the index (the EPD of the first cell's value, plus the index times the EPD between cells), its number a place
   * of the value. An index or a value that is more than a variable goes into a variable of the emitter's own first.
   */
  store(st: Store): void {
    const stride = st.array.length > VARRAY_MOST ? 1 : VARRAY_STRIDE_EPD;
    this.arrays.set(st.array.id, stride);
    const alone = (l: Linear) => l.c === 0 && l.terms.length === 1 && l.terms[0].k === 1;
    let index: string;
    if (alone(st.index)) index = st.index.terms[0].id;
    else {
      index = `${this.key}.si${this.n++}`;
      this.own.add(index);
      this.write(index, st.index, false);
    }
    const own = new Map(st.reads.map((r) => [r.id, `${this.key}.${r.id.slice(1)}`]));
    for (const r of st.reads) {
      this.own.add(own.get(r.id)!);
      if (r.table) this.readTable(own.get(r.id)!, r.table, this.at);
      else this.readShift(own.get(r.id)!, r.shift!, this.at);
    }
    const value: Linear = { c: st.value.c, terms: st.value.terms.map((t) => ({ id: own.get(t.id) ?? t.id, k: t.k })) };
    let from: string | null = null;
    if (value.terms.length && alone(value)) from = value.terms[0].id;
    else if (value.terms.length) {
      from = `${this.key}.sv${this.n++}`;
      this.own.add(from);
      this.write(from, value, false);
    }
    const act: Act = { dword: { element: st.array.id }, modifier: "set", value: from ? 0 : value.c };
    this.actPlaces.set(act, { dest: { id: index, scale: stride, add: 0, base: st.array.id }, ...(from ? { value: { id: from, scale: 1, add: 0 } } : {}) });
    this.push({ conds: [{ dword: this.home(index, 0), compare: "atMost", value: st.array.length - 1 }], items: [{ act }] });
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
  plan(): { copied: Set<string>; order: string[] } {
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
    // Every loop of the graph of reads (Tarjan's strongly connected parts of more than one variable) copied.
    const index = new Map<string, number>(), low = new Map<string, number>(), stack: string[] = [], on = new Set<string>();
    let n = 0;
    const connect = (v: string): void => {
      index.set(v, n); low.set(v, n++); stack.push(v); on.add(v);
      for (const w of readers.get(v) ?? []) {
        if (!index.has(w)) { connect(w); low.set(v, Math.min(low.get(v)!, low.get(w)!)); }
        else if (on.has(w)) low.set(v, Math.min(low.get(v)!, index.get(w)!));
      }
      if (low.get(v) === index.get(v)) {
        const part: string[] = [];
        for (let w = stack.pop()!; ; w = stack.pop()!) { on.delete(w); part.push(w); if (w === v) break; }
        // (Copying the program's variables of a loop breaks it: the emitter's own have no cell to copy from.)
        const real = part.filter((x) => !this.own.has(x) && !isTemp(x));
        if (part.length > 1) (real.length ? real : part).forEach((x) => copied.add(x));
      }
    };
    for (const v of new Set([...this.writes.keys(), ...readers.keys()])) if (!index.has(v)) connect(v);
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
    const { copied, order } = this.plan();
    // (A variable of the emitter's own has no cell on the Python side to copy from.)
    if ([...copied].some((id) => this.own.has(id) || isTemp(id))) return "a variable of the emitter's own would be copied";
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
      if (this.own.has(id) || isTemp(id) || ps.length <= 1 || pinned.has(id) || ps.some((p) => p.synced)) continue;
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
    const fills: { t: Trigger; target: string }[] = [];
    let n = 0;
    for (const p of kept) {
      type Piece = { acts: (Act | WriteAct)[] } | { fill: { temp: string; target: string } } | { copy: string; at?: At } | { island: Stmt } | { call: { fn: FixedFn; target: string }; at?: At } | { refresh: string; places: (Place | WriteAct)[] };
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
        if ("act" in it) acts().push({ ...it.act, value: typeof it.act.value === "object" && "label" in it.act.value ? { label: to(it.act.value.label) } : it.act.value });
        else if ("write" in it) acts().push(...expanded.get(it.write)!);
        else if ("bump" in it) {
          const ps = this.placesOf(it.bump.target);
          if (!copied.has(it.bump.target) && ps.length > MOST_ACTS - 1) this.crowded.add(it.bump.target);
          for (const into of copied.has(it.bump.target) ? ps.slice(0, 1) : ps) acts().push({ into, modifier: "add", value: mul(into.scale, it.bump.add) } as WriteAct);
        }
        else if ("fill" in it) pieces.push({ fill: it.fill });
        else if ("copy" in it) { if (copied.has(it.copy) && !routed.has(it.copy)) pieces.push({ copy: it.copy, ...(it.at ? { at: it.at } : {}) }); }
        else if ("call" in it) pieces.push({ call: it.call, ...(it.at ? { at: it.at } : {}) });
        else {
          pieces.push({ island: it.island });
          // What it may write, back into every place but the cell.
          for (const id of it.writes) if ((this.places.get(id)?.length ?? 0) > 1 && !routed.has(id)) pieces.push({ copy: id, ...(it.island.at ? { at: it.island.at as At } : {}) });
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
          if (reads.some((a) => dirty.has(a.reads!.id))) flush();
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
        if ("fill" in piece) {
          const t: Trigger = { label: label(), conds: [], acts: [], copy: { from: `@${piece.fill.temp}`, into: [] }, ...(p.at ? { at: p.at } : {}) };
          fills.push({ t, target: piece.fill.target });
          made.push(t);
          continue;
        }
        if ("copy" in piece) {
          const at = piece.at ?? p.at;
          made.push({ label: label(), conds: [], acts: [], copy: { from: piece.copy, into: [] }, ...(at ? { at } : {}) });
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
        if (t.copy) { if (!refreshes.some((r) => r.t === t) && !fills.some((f) => f.t === t)) copies.push({ t, id: t.copy.from }); }
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
    // A scratch cell into every place of what reads it (a variable of the emitter's own: its home too).
    for (const { t, target } of fills) for (const p of this.placesOf(target)) t.copy!.into.push({ dword: dwordOf(p), add: num(p.add, p.base), ...(p.scale !== 1 ? { scale: p.scale } : {}) });
    // A copied variable's copies: every place but its cell.
    for (const { t, id } of copies) for (const p of this.placesOf(id).slice(1)) t.copy!.into.push({ dword: dwordOf(p), add: num(p.add, p.base), ...(p.scale !== 1 ? { scale: p.scale } : {}) });
    // Every way out of the graph passes one trigger at its end, where the branches that went there are put back.
    const exit = `${this.key}.end`;
    for (const t of triggers) if (t.next === END) t.next = exit;
    for (const t of triggers) for (const a of t.acts) if (typeof a.value === "object" && "label" in a.value && a.value.label === END) a.value = { label: exit };
    triggers.push({ label: exit, conds: [], acts: (this.restores.get(END) ?? []).map((r) => ({ dword: { at: r.branch, field: "next" }, modifier: "set", value: { label: to(r.to) === END ? exit : to(r.to) } })), next: END });
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
const notZero = (e: NumExpr): BoolExpr => ({ kind: "compare", op: "!=", left: e, right: { kind: "const", value: 0 }, at: { line: 0, column: 0 } as At, label: "" });

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

/** Every variable a statement sets or declares, those inside it included. */
function writtenIn(list: Stmt[], into = new Set<string>()): Set<string> {
  for (const s of list) {
    if (s.kind === "assign") into.add(s.target);
    else if (s.kind === "declare") into.add(s.decl.id);
    for (const v of Object.values(s)) if (Array.isArray(v) && v.length && typeof v[0] === "object" && v[0] && "kind" in v[0]) writtenIn(v as Stmt[], into);
  }
  return into;
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
  const fixed = c.items.filter((x) => [...readIn(x)].every((id) => !written.has(id)));
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

/**
 * A loop's statements as the emitter takes them: a value that is `?:`, `Math.abs`, `Math.min` / `max` as `if` / `else`
 * of plain assignments (`x = c ? a : b` is `if (c) x = a; else x = b`; `x = abs(e)` tests e's sign; a product or
 * quotient's abs tests the result's), such a value inside a sum or a comparison's side computed first into a variable
 * of the emitter's own (`@t…`), and a loop's test that needs that computed at the top of each turn. Every expression
 * moved is pure, so computing it ahead of a test that would have skipped it changes nothing. A statement whose
 * rewriting the emitter would not take whole stays as it was (an island cannot read a variable of the emitter's own).
 */
class Rewriter {
  n = 0;
  readonly key: string;
  readonly take: (list: Stmt[]) => boolean;
  constructor(key: string, take: (list: Stmt[]) => boolean) {
    this.key = key;
    this.take = take;
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

  /** `e` with every `?:`, abs, min and max in it computed first into a variable of the emitter's own. */
  flat(e: NumExpr, pre: Stmt[], where: { at: At; label: string }): NumExpr {
    if (this.invariant(e)) {
      const t = this.temp();
      // (Computed once, ahead of the loop; the rest of this rewriting sees a variable.)
      const h = this.hoist!;
      this.hoist = null;
      try {
        h.out.push(...this.set(t, e, where));
      } finally {
        this.hoist = h;
      }
      return { kind: "var", id: t };
    }
    switch (e.kind) {
      case "binary": return { ...e, left: this.flat(e.left, pre, where), right: this.flat(e.right, pre, where) };
      case "unary": case "cast": return { ...e, expr: this.flat(e.expr, pre, where) };
      case "element": return { ...e, index: this.flat(e.index, pre, where) };
      case "ternary": case "intrinsic": {
        if (e.kind === "intrinsic" && e.name !== "abs" && e.name !== "min" && e.name !== "max") return { ...e, args: e.args.map((a) => this.flat(a, pre, where)) };
        const t = this.temp();
        pre.push(...this.set(t, e, where));
        return { kind: "var", id: t };
      }
      default: return e;
    }
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
      const a = this.flat(e.args[0], pre, where);
      if (linear(a)) return [...pre, { kind: "if", cond: { kind: "compare", op: "<", left: a, right: zero, ...where }, then: [assign({ kind: "unary", op: "-", expr: a, at: where.at })], else: [assign(a)], ...where }];
      // (A product or a quotient: into the target first, its sign tested there.)
      return [...pre, assign(a), { kind: "if", cond: { kind: "compare", op: "<", left: v(target), right: zero, ...where }, then: [assign({ kind: "unary", op: "-", expr: v(target), at: where.at })], ...where }];
    }
    if (e.kind === "intrinsic" && (e.name === "min" || e.name === "max") && e.args.length === 2) {
      const [a, b] = e.args.map((x) => this.side(this.flat(x, pre, where), pre, where));
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

  cond(c: BoolExpr, pre: Stmt[], where: { at: At; label: string }): BoolExpr {
    switch (c.kind) {
      case "compare": return { ...c, left: this.side(this.flat(c.left, pre, where), pre, where), right: this.side(this.flat(c.right, pre, where), pre, where) };
      case "test": return { ...c, expr: this.side(this.flat(c.expr, pre, where), pre, where) };
      case "and": case "or": return { ...c, items: c.items.map((x) => this.cond(x, pre, where)) };
      case "not": return { ...c, expr: this.cond(c.expr, pre, where) };
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
        const init = s.init as NumExpr;
        if (s.decl.kind !== "number" || plain(init)) return [s];
        return keep([{ ...s, init: { kind: "const", value: 0 } }, ...this.set(s.decl.id, init, where)]);
      }
      case "block": return [{ ...s, body: this.stmts(s.body) }];
      case "store": {
        // A value the emitter does not take as it is into a variable of its own first; the index likewise.
        const value = s.value as NumExpr;
        const pre: Stmt[] = [];
        const index = plain(s.index) ? s.index : this.side(this.flat(s.index, pre, where), pre, where);
        let stored: NumExpr = value;
        if (!plain(value) && !this.table(value)) {
          const t = this.temp();
          pre.push(...this.set(t, value, where));
          stored = { kind: "var", id: t };
        }
        return pre.length ? keep([...pre, { ...s, index, value: stored }]) : [s];
      }
      case "if": {
        const pre: Stmt[] = [];
        const cond = this.cond(s.cond, pre, where);
        const head = pre.length && this.take([...pre]) ? pre : null;
        const out: Stmt = { ...s, cond: head ? cond : s.cond, then: this.stmts(s.then), ...(s.else ? { else: this.stmts(s.else) } : {}) };
        return head ? [...head, out] : [out];
      }
      case "while": case "for": {
        const pre: Stmt[] = [];
        const cond = s.cond ? this.cond(s.cond, pre, where) : undefined;
        const body = this.stmts(s.body);
        const update = s.kind === "for" ? this.stmts(s.update) : [];
        if (!pre.length || !this.take([...pre])) return [s.kind === "for" ? { ...s, body, update } : { ...s, body }];
        // The test needs values computed first: at the top of each turn, before it.
        const leave: Stmt = { kind: "if", cond: { kind: "not", expr: cond! }, then: [{ kind: "break", ...where }], ...where };
        return [s.kind === "for" ? { ...s, cond: undefined, body: [...pre, leave, ...body], update } : { ...s, cond: undefined, body: [...pre, leave, ...body] }];
      }
      case "do": return [{ ...s, body: this.stmts(s.body) }];
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
        return pre.length ? keep([...pre, { ...s, value }]) : [s];
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
 * The loops the emitter takes, replaced by `graph` statements: `{ kind: "graph", graph, original }`. Returns how many
 * it took. A per-player program is not looked at yet (its variables are rows), nor a task's (its variables are slots).
 */
/** How often the emitter did what is worth counting, for its tests: loops with values computed once on the way in. */
export const emitterCounts = { hoisted: 0, reciprocals: 0, jumps: 0 };

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
