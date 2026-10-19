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
import type { BoolExpr, NumExpr, Program, Stmt, VarDecl, At } from "../ir";
import { END, MOST_ACTS, MOST_CONDS, checkGraph, type Act, type Compare, type Cond, type Dword, type Graph, type Trigger } from "./graph";

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

function linear(e: NumExpr): Linear | null {
  switch (e.kind) {
    case "const": return e.fn ? null : { c: u(e.value), terms: [] };
    case "var": return { c: 0, terms: [{ id: e.id, k: 1 }] };
    case "cast": return e.to === "fixed" ? null : linear(e.expr);
    case "unary": {
      const l = linear(e.expr);
      return l && scaled(l, MAX);
    }
    case "binary": {
      const a = linear(e.left), b = linear(e.right);
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

/** One variable plus a constant, or a constant: what a comparison's side can be. */
type Side = { id: string; c: number } | { k: number };
function side(e: NumExpr): Side | null {
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
        if (!side(e.left) || !side(e.right)) return this.no("a comparison of more than a variable and a constant");
        return this.num(e.left) && this.num(e.right);
      }
      case "test": return !!side(e.expr) && this.num(e.expr);
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
    const d = this.decls.get(id);
    return !!d && d.kind === "number" && !d.bits && d.task === undefined && !d.held;
  }

  stmts(list: Stmt[], inLoop: boolean): boolean {
    return list.every((s) => this.stmt(s, inLoop));
  }

  stmt(s: Stmt, inLoop: boolean): boolean {
    switch (s.kind) {
      case "remark": return true;
      case "block": return this.stmts(s.body, inLoop);
      case "declare": {
        if (!this.ok(s.decl.id)) return this.no(`the variable ${s.decl.name}`);
        if (!this.num(s.init as NumExpr)) return false;
        this.declared.add(s.decl.id);
        this.written.add(s.decl.id);
        return true;
      }
      case "assign": {
        if (!this.ok(s.target)) return this.no(`the variable ${this.decls.get(s.target)?.name ?? s.target}`);
        if (!this.num(s.value)) return false;
        this.written.add(s.target);
        return true;
      }
      case "if": return this.bool(s.cond) && this.stmts(s.then, inLoop) && this.stmts(s.else ?? [], inLoop);
      case "while": return (!s.cond || this.bool(s.cond)) && this.stmts(s.body, true);
      case "do": return this.bool(s.cond) && this.stmts(s.body, true);
      case "for": return (!s.cond || this.bool(s.cond)) && this.stmts(s.update, true) && this.stmts(s.body, true);
      case "break": case "continue": return inLoop;
      default: return this.no(`a ${s.kind}`);
    }
  }
}

// ── the layout ──

/** A write of a variable, laid out where the statement was, expanded once every place of the variable is known. */
interface Write { target: string; value: Linear }
/** An action of an expanded write: it writes `into`; a variable it reads plus a constant is in its own number. */
interface WriteAct { into: Place; modifier: "set" | "add"; value: number; reads?: Read }
/** What an action's or a condition's number holds: the variable times `scale`, plus `add` (wrapping). */
interface Read { id: string; scale: number; add: number }
type Item = { act: Act } | { write: Write } | { copy: string };
interface Proto { label: string; conds: Cond[]; items: Item[]; next?: string; at?: At }

/**
 * A place of a variable: a dword that holds it times `scale` plus `add` (wrapping) — known (its cell, a home, a
 * condition's number) or the number of an action of an expanded write, found when the triggers are cut.
 */
interface Place { dword?: Dword; act?: WriteAct; scale: number; add: number }

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
  loops: { cont: string; exit: string }[] = [];

  readonly key: string;
  constructor(key: string) {
    this.key = key;
  }

  label(what: string): string {
    return `${this.key}.${what}${this.n++}`;
  }

  placesOf(id: string): Place[] {
    let p = this.places.get(id);
    if (!p) this.places.set(id, (p = [{ dword: { var: id }, scale: 1, add: 0 }]));
    return p;
  }

  /** A dword that holds the variable plus `add`, for conditions to read as memory. */
  home(id: string, add: number): Dword {
    add = u(add);
    if (add === 0) return { var: id };
    const name = `${this.key}.h.${id}.${add}`;
    if (!this.homes.has(name)) {
      this.homes.add(name);
      this.placesOf(id).push({ dword: { data: name }, scale: 1, add });
    }
    return { data: name };
  }

  push(p: Omit<Proto, "label"> & { label?: string }): Proto {
    const t: Proto = { label: p.label ?? this.label("t"), conds: p.conds, items: p.items, next: p.next, at: p.at };
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
    if (last && last.conds.length === 0 && last.next === undefined) return last;
    return this.push({ conds: [], items: [] });
  }

  write(target: string, value: Linear): void {
    const w = { target, value };
    // (The copy is there for a variable that turns out to need one: the rest leave it out.)
    this.open().items.push({ write: w }, { copy: target });
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
    if ((e.kind === "and" && when) || (e.kind === "or" && !when)) {
      const parts = e.items.map((x) => this.single(x, when));
      if (parts.some((p) => p === null)) return null;
      if (parts.includes("false")) return "false";
      const conds = parts.filter((p): p is Cond[] => Array.isArray(p)).flat();
      return conds.length === 0 ? "true" : conds.length <= MOST_CONDS ? conds : null;
    }
    if (e.kind !== "compare") return null;
    if (e.unsigned === "left" || e.unsigned === "right") return this.single(plain(e), when);
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
    switch (s.kind) {
      case "remark": return;
      case "block": return this.stmts(s.body);
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
      case "break": return this.goto(this.loops[this.loops.length - 1].exit);
      case "continue": return this.goto(this.loops[this.loops.length - 1].cont);
      default: throw new Error(`emitter: ${s.kind}`);
    }
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
    const copied = new Set<string>();
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
        if (part.length > 1) part.forEach((x) => copied.add(x));
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
        out.push({ into, modifier: "set", value: 0, reads: { id: first.id, scale: first.scale, add: u(c + into.add) } });
      } else out.push({ into, modifier: "set", value: u(c + into.add) });
      for (const t of parts) out.push({ into, modifier: "add", value: 0, reads: { id: t.id, scale: t.scale, add: 0 } });
    }
    return out;
  }

  graph(entries: string[]): Graph | string {
    const { copied, order } = this.plan();
    // A comparison's number is a place of what it reads: its trigger keeps its label and the condition its index.
    for (const p of this.protos) p.conds.forEach((c, k) => {
      const r = this.condReads.get(c);
      if (r) this.placesOf(r.id).push({ dword: { at: p.label, field: { cond: k } }, scale: r.scale, add: r.add });
    });
    // Each target's writes expanded once all its places are known — the writes that read it come first in the
    // order, and each action that reads a variable is a place of it.
    const expanded = new Map<Write, WriteAct[]>();
    for (const v of order) for (const w of this.writes.get(v) ?? []) {
      const acts = this.expand(w, copied.has(v));
      expanded.set(w, acts);
      for (const a of acts) if (a.reads) this.placesOf(a.reads.id).push({ act: a, scale: a.reads.scale, add: a.reads.add });
    }
    // Every fall-through said, so that dropping a trigger leaves the one before it going where it went.
    this.protos.forEach((p, i) => { if (p.next === undefined) p.next = this.protos[i + 1]?.label ?? END; });
    // Empty triggers dropped: their labels stand for where they went.
    const alias = new Map<string, string>();
    const kept: Proto[] = [];
    for (const p of this.protos) {
      if (p.conds.length === 0 && p.items.length === 0 && !this.restores.get(p.label)?.length) alias.set(p.label, p.next!);
      else kept.push(p);
    }
    const to = (l: string): string => {
      while (alias.has(l)) l = alias.get(l)!;
      return l;
    };
    // The triggers: puts-back and actions in order, cut at 64 and around the copies.
    const triggers: Trigger[] = [];
    const at = new Map<WriteAct, Dword>();
    const later: { t: Trigger; k: number; w: WriteAct }[] = [];
    const copies: { t: Trigger; id: string }[] = [];
    let n = 0;
    for (const p of kept) {
      type Piece = { acts: (Act | WriteAct)[] } | { copy: string };
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
        if ("act" in it) acts().push({ ...it.act, value: typeof it.act.value === "object" ? { label: to(it.act.value.label) } : it.act.value });
        else if ("write" in it) acts().push(...expanded.get(it.write)!);
        else if (copied.has(it.copy)) pieces.push({ copy: it.copy });
      }
      if (p.conds.length && (pieces.length > 1 || (pieces[0] as { acts: unknown[] }).acts.length > MOST_ACTS)) return "a branch with too many actions";
      // Each piece one trigger or more: the first takes the label and the conditions, each goes to the one after it.
      const made: Trigger[] = [];
      for (const piece of pieces) {
        if ("copy" in piece) {
          made.push({ label: made.length ? `${this.key}.cut${n++}` : p.label, conds: [], acts: [], copy: { from: piece.copy, into: [] } });
          continue;
        }
        for (let i = 0; i === 0 || i < piece.acts.length; i += MOST_ACTS) {
          if (i === 0 && piece.acts.length === 0 && made.length) break;
          const t: Trigger = { label: made.length ? `${this.key}.cut${n++}` : p.label, conds: made.length ? [] : p.conds.map((c) => ({ ...c })), acts: [], ...(p.at ? { at: p.at } : {}) };
          piece.acts.slice(i, i + MOST_ACTS).forEach((a, k) => {
            if ("into" in a) {
              at.set(a, { at: t.label, field: { act: k, part: "value" } });
              later.push({ t, k, w: a });
              t.acts.push({ dword: { game: 0 }, modifier: a.modifier, value: a.value });
            } else t.acts.push(a);
          });
          made.push(t);
        }
      }
      // A copy goes on to the trigger after it; the others say where they go. The last goes where the proto went.
      if (made[made.length - 1].copy) made.push({ label: `${this.key}.cut${n++}`, conds: [], acts: [] });
      made.forEach((t, i) => {
        if (t.copy) copies.push({ t, id: t.copy.from });
        else t.next = i === made.length - 1 ? to(p.next!) : made[i + 1].label;
      });
      triggers.push(...made);
    }
    // Where each write's action writes, now that every place has its dword.
    const dwordOf = (p: Place): Dword => p.dword ?? at.get(p.act!)!;
    for (const { t, k, w } of later) t.acts[k].dword = dwordOf(w.into);
    // A copied variable's copies: every place but its cell.
    for (const { t, id } of copies) for (const p of this.placesOf(id).slice(1)) t.copy!.into.push({ dword: dwordOf(p), add: p.add, ...(p.scale !== 1 ? { scale: p.scale } : {}) });
    // Every way out of the graph passes one trigger at its end, where the branches that went there are put back.
    const exit = `${this.key}.end`;
    for (const t of triggers) if (t.next === END) t.next = exit;
    for (const t of triggers) for (const a of t.acts) if (typeof a.value === "object" && a.value.label === END) a.value = { label: exit };
    triggers.push({ label: exit, conds: [], acts: (this.restores.get(END) ?? []).map((r) => ({ dword: { at: r.branch, field: "next" }, modifier: "set", value: { label: to(r.to) === END ? exit : to(r.to) } })), next: END });
    // What the graph reads that was written before it, copied into its places on the way in.
    const graph: Graph = { entries: [], triggers };
    for (const id of entries) for (const p of this.placesOf(id)) {
      const d = dwordOf(p);
      if ("var" in d && d.var === id && p.add === 0 && p.scale === 1) continue;
      graph.entries.push({ from: id, into: d, add: p.add, ...(p.scale !== 1 ? { scale: p.scale } : {}) });
    }
    const problems = checkGraph(graph);
    return problems.length ? problems.join("; ") : graph;
  }
}

type CompareOp = "<" | "<=" | ">" | ">=" | "==" | "!=";
const FLIP = { "<": ">", "<=": ">=", ">": "<", ">=": "<=", "==": "==", "!=": "!=" } as const;
const INVERSE = { "<": ">=", "<=": ">", ">": "<=", ">=": "<", "==": "!=", "!=": "==" } as const;
const notZero = (e: NumExpr): BoolExpr => ({ kind: "compare", op: "!=", left: e, right: { kind: "const", value: 0 }, at: { line: 0, column: 0 } as At, label: "" });

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
 * The loops the emitter takes, replaced by `graph` statements: `{ kind: "graph", graph, original }`. Returns how many
 * it took. A per-player program is not looked at yet (its variables are rows), nor a task's (its variables are slots).
 */
/** One loop lowered to a graph, or why it is not. `decls`: every variable of the program, by id. */
export function emitLoop(s: Stmt, decls: Map<string, VarDecl>, key: string): Graph | string {
  const scope = new Scope(decls);
  if (!scope.stmt(s, false)) return scope.why || "?";
  const e = new Emitter(key);
  e.stmt(s);
  e.goto(END);
  return e.graph([...scope.read].filter((id) => !scope.declared.has(id)));
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
  let taken = 0;
  const visit = (list: Stmt[]): void => {
    for (let i = 0; i < list.length; i++) {
      const s = list[i];
      if (s.kind === "while" || s.kind === "for" || s.kind === "do") {
        const g = emitLoop(s, decls, `g${taken}`);
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
