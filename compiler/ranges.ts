/**
 * The values each number of a program can take (TrigScript 4, the limits): a range, lowest and highest, for every
 * number variable, and written into each number of the IR whose range is narrower than its 32 bits (`NumExpr.range`).
 * Nothing in the language changes. The Python backend takes only the bits a range has — a product by a constant, a
 * quotient, a shift, an index — and drops a bounds check a range says cannot fail; the simulator reads no ranges.
 *
 * Run after `typeNumbers` (the casts are gone and every operation says how it reads its sides). A range is of the
 * number's signed reading: a `u32` above 2 147 483 647 reads below zero, and an operation whose `unsigned` reading
 * would differ takes a range only when its sides are known to be at or above zero, where both readings agree.
 *
 * How it is sound:
 * - **Every store is seen.** A variable's range is the union of everything ever stored into it — declarations,
 *   assignments, a call's arguments into its parameters, returns into results — and 0, what a cell holds before its
 *   first store. A variable nothing visible stores into (a task's handle, the error in flight, a loop's `was`) is any
 *   number. The passes go on until no range grows; one still growing after eight is widened to any number.
 * - **What a test says, while it holds.** Inside `if (i < n)` the pass knows `i` is below the highest `n` can be,
 *   until something stores into `i`. Such facts are dropped at everything that could change what they are about
 *   behind their back: a wait (another task runs), a call of a kept function, a statement whose expressions hold a
 *   call, the top of a loop for everything the loop stores into, a `catch`. A loop's own test holds at the top of its
 *   body and, when the body stores nothing into the variable and neither waits nor calls, at its update — so
 *   `for (let i = 0; i < 16; i++)` keeps `i` within 0 … 16 with no rule of its own.
 * - **Arrays** take a range only when nothing else can reach their cells: a table known when built (`values`), or an
 *   array of a fixed length that is no window (`slice`), no row of another (`through`), no array of texts' rows, and
 *   that nothing views; any read of one also gives 0, past its ends. A `u8` / `u16` array is its bits' range.
 * - **A statement kind the pass does not know** leaves the whole program without ranges.
 */
import { eachCall, isTextExpr, mapText, mapTextOperands, mapTextParts, programDeclarations, UNIT_FLAGS, type ArrayDecl, type BoolExpr, type Call, type NumExpr, type Program, type Stmt, type TextExpr, type TextMap, type TextPart, type UnitExpr, type VarDecl } from "./ir";

/** Lowest and highest, both inclusive, of the signed reading. */
export type Range = readonly [number, number];

const MIN = -2147483648, MAX = 2147483647;
export const ANY: Range = [MIN, MAX];
const FIXED_PI = 205887;

const fits = (lo: number, hi: number): Range => (lo < MIN || hi > MAX || !Number.isFinite(lo) || !Number.isFinite(hi) ? ANY : [lo, hi]);
const join = (a: Range | null, b: Range | null): Range | null => (!a ? b : !b ? a : [Math.min(a[0], b[0]), Math.max(a[1], b[1])]);
const meet = (a: Range, b: Range): Range => { const lo = Math.max(a[0], b[0]), hi = Math.min(a[1], b[1]); return lo > hi ? a : [lo, hi]; };
const isAny = (r: Range) => r[0] === MIN && r[1] === MAX;
const nonNeg = (r: Range) => r[0] >= 0;
const withZero = (r: Range): Range => [Math.min(r[0], 0), Math.max(r[1], 0)];
const signed = (v: number) => v | 0;
/** The smallest 2^k − 1 at or above v (v ≥ 0). */
const ones = (v: number) => (v <= 0 ? 0 : 2 ** Math.ceil(Math.log2(v + 1)) - 1);

/** A unit's numbers as `field_of` reads them: whole points of a 24.8 cell, a byte, a word. 0 when the unit is gone. */
const UNIT_FIELD: Record<string, Range> = {
  hp: [0, 16777216], maxHp: [0, 16777215], shields: [0, 16777215], maxShields: [0, 65535], energy: [0, 255],
  owner: [0, 255], type: [0, 65535], x: [0, 65535], y: [0, 65535], kills: [0, 255], orderId: [0, 255], cooldown: [0, 255],
  resources: [0, 65535], stim: [0, 65535], ensnare: [0, 65535], plague: [0, 65535], lockdown: [0, 65535], maelstrom: [0, 65535],
  irradiate: [0, 65535], stasis: [0, 65535],
};

const STMT_KINDS = new Set(["declare", "assignText", "storeText", "releaseText", "textLoop", "assign", "declareArray", "store", "push", "pop", "setLength",
  "assignBool", "assignUnit", "unitLoop", "unitWrite", "unitDo", "tableWrite", "if", "while", "do", "for", "unrolled", "switch", "break", "continue",
  "return", "sleep", "parallel", "start", "cancel", "action", "syncSend", "select", "centerLocation", "print", "buildText", "call", "block", "try",
  "throw", "uncaught", "remark"]);

type Facts = Map<string, Range>;
const FLAGS: ReadonlySet<string> = new Set(UNIT_FLAGS);

/** Whether anything in this piece of IR is a call (of a kept function or inlined): its body may store anything. */
function holdsCall(root: unknown, seen = new WeakMap<object, boolean>()): boolean {
  if (!root || typeof root !== "object") return false;
  const known = seen.get(root);
  if (known !== undefined) return known;
  seen.set(root, false);
  const o = root as Record<string, unknown>;
  let out = (o.kind === "call" || o.kind === "textCall") && !!o.call && typeof o.call === "object";
  if (!out) for (const v of Array.isArray(root) ? root : Object.values(o)) if (v && typeof v === "object" && holdsCall(v, seen)) { out = true; break; }
  seen.set(root, out);
  return out;
}

/** The number variables a list of statements stores into anywhere in it (calls' bodies and parameters too), and whether it waits. */
function effects(stmts: Stmt[]): { stores: Set<string>; waits: boolean } {
  const stores = new Set<string>();
  let waits = false;
  const scan = (x: unknown) => {
    if (!x || typeof x !== "object") return;
    if (Array.isArray(x)) { x.forEach(scan); return; }
    const o = x as Record<string, unknown>;
    if (o.kind === "assign" && typeof o.target === "string") stores.add(o.target);
    if (o.kind === "declare" && o.decl && typeof o.decl === "object") stores.add((o.decl as VarDecl).id);
    if (o.kind === "sleep" || o.kind === "parallel") waits = true;
    if (o.kind === "unitLoop" && o.was) stores.add((o.was as VarDecl).id);
    if (o.kind === "start" && typeof o.handle === "string") stores.add(o.handle);
    if (Array.isArray(o.params)) for (const p of o.params as { decl?: VarDecl }[]) if (p?.decl?.id) stores.add(p.decl.id);
    if (o.result && typeof o.result === "object" && (o.result as { decl?: VarDecl }).decl) stores.add((o.result as { decl: VarDecl }).decl.id);
    for (const v of Object.values(o)) if (v && typeof v === "object") scan(v);
  };
  scan(stmts);
  return { stores, waits };
}

export function rangeNumbers(program: Program): void {
  const functions = new Map((program.functions ?? []).map((f) => [f.id, f]));
  const arrays = new Map(program.arrays.map((a) => [a.id, a]));
  /** The ranges as the last pass left them, and what this pass finds. */
  let vars = new Map<string, Range>();
  let next = new Map<string, Range>();
  let cells = new Map<string, Range>();
  let nextCells = new Map<string, Range>();
  /** Variables any number can be stored into behind the program's back. */
  const wild = new Set<string>();
  if (program.errors) wild.add(program.errors.thrown);
  /** Arrays whose cells something reaches that the pass does not follow. */
  const reached = new Set<string>();
  for (const a of program.arrays) {
    if (a.slice) { reached.add(a.id); reached.add(a.slice.of); }
    if (a.through) { reached.add(a.id); for (const k of ["ptr", "len", "room", "k"] as const) reached.add(a.through[k]); }
    if (a.dynamic) reached.add(a.id);
  }
  /** How many places in the program store into each variable (declarations, assignments, parameters, results). */
  const sites = new Map<string, number>();
  {
    const site = (id: string) => sites.set(id, (sites.get(id) ?? 0) + 1);
    const scan = (x: unknown) => {
      if (!x || typeof x !== "object") return;
      if (Array.isArray(x)) { x.forEach(scan); return; }
      const o = x as Record<string, unknown>;
      if (o.kind === "assign" && typeof o.target === "string") site(o.target);
      if (o.kind === "declare" && o.decl && typeof o.decl === "object") site((o.decl as VarDecl).id);
      if (o.kind === "unitLoop" && o.was) site((o.was as VarDecl).id);
      if (o.kind === "start" && typeof o.handle === "string") site(o.handle);
      if (Array.isArray(o.params)) for (const p of o.params as { decl?: VarDecl }[]) if (p?.decl?.id) site(p.decl.id);
      if (o.result && typeof o.result === "object" && (o.result as { decl?: VarDecl }).decl) site((o.result as { decl: VarDecl }).decl.id);
      for (const v of Object.values(o)) if (v && typeof v === "object") scan(v);
    };
    scan(program);
  }
  const declOf = new Map(programDeclarations(program).map((d) => [d.id, d]));
  /**
   * A loop's counter whose only stores are its declaration and the loop's update: nothing else can change it, behind
   * the loop's back or not, so what the loop's test said of it holds through a wait or a call in the body. Not one
   * shared by several runs of the same code at once (a task's slots, a per-player program's rows).
   */
  const pinned = new Set<string>();
  let inTask = false;
  const forget = (facts: Facts) => { for (const k of [...facts.keys()]) if (!pinned.has(k)) facts.delete(k); };
  const keepPinned = (facts: Facts): Facts => new Map([...facts].filter(([k]) => pinned.has(k)));
  const effectCache = new WeakMap<Stmt[], ReturnType<typeof effects>>();
  const effectsOf = (s: Stmt[]) => { let e = effectCache.get(s); if (!e) { e = effects(s); effectCache.set(s, e); } return e; };
  const callCache = new WeakMap<object, boolean>();
  let unknown = false;
  /** On the last pass: write each number's range into it. A node met twice (an expression the front end put in two places) takes the union. */
  let annotate = false;
  const written = new WeakMap<object, Range>();
  const mark = (e: NumExpr, r: Range): Range => {
    if (!annotate) return r;
    const was = written.get(e);
    const out = was ? (join(was, r) as Range) : r;
    written.set(e, out);
    if (isAny(out) || e.kind === "const") delete (e as { range?: Range }).range;
    else (e as { range?: Range }).range = out;
    return r;
  };

  /** After the first pass: the variables some store of the program names. One no store names is set behind its back. */
  let stored: Set<string> | null = null;
  const varRange = (id: string): Range => (wild.has(id) || (stored && !stored.has(id)) ? ANY : vars.get(id) ?? [0, 0]);
  // (A list's lowest and highest once each: a video's table is hundreds of thousands of cells, too many to spread.)
  const listed = new Map<string, Range>();
  const arrayRange = (a: ArrayDecl | undefined): Range => {
    if (!a) return ANY;
    if (a.values) {
      let r = listed.get(a.id);
      if (!r) {
        let lo = Infinity, hi = -Infinity;
        for (const v of a.values) { const x = signed(v); if (x < lo) lo = x; if (x > hi) hi = x; }
        listed.set(a.id, (r = withZero(a.values.length ? [lo, hi] : [0, 0])));
      }
      return r;
    }
    if (a.bits) return [0, 2 ** a.bits - 1];
    if (reached.has(a.id)) return ANY;
    return withZero(cells.get(a.id) ?? [0, 0]);
  };
  const store = (id: string, r: Range) => { next.set(id, join(next.get(id) ?? null, r)!); };
  const storeCell = (id: string, r: Range) => { nextCells.set(id, join(nextCells.get(id) ?? null, r)!); };

  /** Facts a condition gives about variables, when it holds (`truth` true) or does not. */
  const factsOf = (c: BoolExpr, truth: boolean, facts: Facts, out: Facts) => {
    if (c.kind === "not") { factsOf(c.expr, !truth, facts, out); return; }
    if (c.kind === "and" && truth) { for (const i of c.items) factsOf(i, true, facts, out); return; }
    if (c.kind === "or" && !truth) { for (const i of c.items) factsOf(i, false, facts, out); return; }
    if (c.kind !== "compare") return;
    // One side a u32, the other signed ("left" / "right"), compared exactly: when the u32 side reads at or above zero
    // its value is its signed reading, and the comparison is an ordinary one.
    if (c.unsigned === "left" && !nonNeg(num(c.left, facts, true))) return;
    if (c.unsigned === "right" && !nonNeg(num(c.right, facts, true))) return;
    const op = truth ? c.op : ({ "<": ">=", "<=": ">", ">": "<=", ">=": "<", "==": "!=", "!=": "==" } as const)[c.op];
    const side = (v: NumExpr, other: NumExpr, o: typeof op) => {
      if (v.kind !== "var") return;
      const r = num(other, facts, true);
      const unsignedOk = c.unsigned !== true || (nonNeg(r) && nonNeg(varRange(v.id)));
      if (!unsignedOk) return;
      const have = out.get(v.id) ?? facts.get(v.id) ?? varRange(v.id);
      let f: Range | null = null;
      if (o === "<") f = [MIN, r[1] - 1];
      else if (o === "<=") f = [MIN, r[1]];
      else if (o === ">") f = [r[0] + 1, MAX];
      else if (o === ">=") f = [r[0], MAX];
      else if (o === "==") f = r;
      if (f && f[0] <= f[1]) out.set(v.id, meet(have, f));
    };
    const flip = { "<": ">", "<=": ">=", ">": "<", ">=": "<=", "==": "==", "!=": "!=" } as const;
    side(c.left, c.right, op);
    side(c.right, c.left, flip[op]);
  };
  const withFacts = (facts: Facts, c: BoolExpr, truth: boolean): Facts => { const out = new Map(facts); const add: Facts = new Map(); factsOf(c, truth, facts, add); for (const [k, v] of add) out.set(k, v); return out; };

  const texts = (facts: Facts): TextMap => ({ num: (e) => { num(e, facts); return e; }, bool: (e) => { bool(e, facts); return e; }, call: (c) => { call(c, new Map()); return c; } });
  const text = (t: TextExpr, facts: Facts) => { mapText(t, texts(facts)); };
  const parts = (p: TextPart[], facts: Facts) => { mapTextParts(p, texts(facts)); };

  /** A number's range under the facts; `quiet`: only looking (a fact's other side), nothing written. */
  function num(e: NumExpr, facts: Facts, quiet = false): Range {
    const was = annotate;
    if (quiet) annotate = false;
    try { return mark(e, numOf(e, facts)); } finally { annotate = was; }
  }

  function numOf(e: NumExpr, facts: Facts): Range {
    switch (e.kind) {
      case "const": { const v = signed(e.value); return [v, v]; }
      case "var": { const r = varRange(e.id); const f = wild.has(e.id) ? undefined : facts.get(e.id); return f ? meet(r, f) : r; }
      case "element": num(e.index, facts); return arrayRange(arrays.get(e.array));
      case "pop": return arrayRange(arrays.get(e.array));
      case "length": { const a = arrays.get(e.array); return a && !a.dynamic && !a.slice && !a.through ? [a.length, a.length] : [0, MAX]; }
      case "unitPart": unit(e.unit, facts); return e.part === "uid" ? [0, 255] : ANY;
      case "unary": { const r = num(e.expr, facts); return r[0] === MIN ? ANY : [-r[1], -r[0]]; }
      case "cast": { const r = num(e.expr, facts); return e.to === "fixed" ? ANY : r; }
      case "binary": return binary(e, num(e.left, facts), num(e.right, facts));
      case "read": return ANY;
      case "randomInt": { const b = num(e.bound, facts); return nonNeg(b) ? [0, Math.max(0, b[1] - 1)] : ANY; }
      case "unitField": unit(e.unit, facts); return UNIT_FIELD[e.field] ?? ANY;
      case "tableRead": return ANY;
      case "input": return ANY;
      case "ternary": bool(e.cond, facts); return join(num(e.whenTrue, withFacts(facts, e.cond, true)), num(e.whenFalse, withFacts(facts, e.cond, false)))!;
      case "intrinsic": return intrinsic(e, facts);
      case "textLength": mapTextOperands(e, texts(facts)); return [0, 1023];
      case "textIndexOf": mapTextOperands(e, texts(facts)); return [-1, 1023];
      case "textCode": mapTextOperands(e, texts(facts)); return [-1, 0x10ffff];
      case "taskHandle": return [0, MAX];
      case "call": { call(e.call, new Map()); const d = e.call.result?.decl; return d ? varRange(d.id) : ANY; }
      default: unknown = true; return ANY;
    }
  }

  function binary(e: Extract<NumExpr, { kind: "binary" }>, a: Range, b: Range): Range {
    const both = nonNeg(a) && nonNeg(b);
    switch (e.op) {
      case "+": return fits(a[0] + b[0], a[1] + b[1]);
      case "-": return fits(a[0] - b[1], a[1] - b[0]);
      case "*": { const p = [a[0] * b[0], a[0] * b[1], a[1] * b[0], a[1] * b[1]]; return fits(Math.min(...p), Math.max(...p)); }
      case "/": {
        if (e.unsigned && !both) return ANY;
        const qs: number[] = [];
        for (const d of [[b[0], Math.min(b[1], -1)], [Math.max(b[0], 1), b[1]]] as const) {
          if (d[0] > d[1]) continue;
          for (const x of [a[0], a[1]]) for (const y of [d[0], d[1]]) qs.push(Math.trunc(x / y));
        }
        if (b[0] <= 0 && b[1] >= 0) qs.push(0);
        return qs.length ? fits(Math.min(...qs), Math.max(...qs)) : [0, 0];
      }
      case "%": {
        if (e.unsigned && !both) return ANY;
        const m = Math.max(Math.abs(b[0]), Math.abs(b[1]));
        if (m === 0) return [0, 0]; // a divisor of 0 gives 0
        const lo = a[0] >= 0 ? 0 : Math.max(a[0], -(m - 1)), hi = a[1] <= 0 ? 0 : Math.min(a[1], m - 1);
        return withZero([lo, hi]);
      }
      case "&":
        if (both) return [0, Math.min(a[1], b[1])];
        if (nonNeg(a)) return [0, a[1]];
        if (nonNeg(b)) return [0, b[1]];
        return ANY;
      case "|": case "^": return both ? [0, ones(Math.max(a[1], b[1]))] : ANY;
      case "<<":
        if (b[0] === b[1] && b[0] >= 0 && b[0] < 32) return fits(a[0] * 2 ** b[0], a[1] * 2 ** b[0]);
        return ANY;
      case ">>":
        if (b[0] === b[1] && b[0] >= 0 && b[0] < 32) return [Math.floor(a[0] / 2 ** b[0]), Math.floor(a[1] / 2 ** b[0])];
        return nonNeg(a) && nonNeg(b) ? [0, a[1]] : ANY;
      case ">>>":
        if (b[0] === b[1] && b[0] >= 1 && b[0] < 32) return nonNeg(a) ? [Math.floor(a[0] / 2 ** b[0]), Math.floor(a[1] / 2 ** b[0])] : [0, Math.floor(0xffffffff / 2 ** b[0])];
        if (b[0] === b[1] && b[0] === 0) return a;
        return nonNeg(a) && nonNeg(b) ? [0, a[1]] : ANY;
      default: return ANY;
    }
  }

  function intrinsic(e: Extract<NumExpr, { kind: "intrinsic" }>, facts: Facts): Range {
    const r = e.args.map((x) => num(x, facts));
    switch (e.name) {
      case "min": return e.unsigned && !r.every(nonNeg) ? ANY : [Math.min(...r.map((x) => x[0])), Math.min(...r.map((x) => x[1]))];
      case "max": return e.unsigned && !r.every(nonNeg) ? ANY : [Math.max(...r.map((x) => x[0])), Math.max(...r.map((x) => x[1]))];
      case "abs": { const [lo, hi] = r[0]; if (lo === MIN) return ANY; return lo >= 0 ? [lo, hi] : hi <= 0 ? [-hi, -lo] : [0, Math.max(-lo, hi)]; }
      case "fmul": { const [a, b] = r; const p = [a[0] * b[0], a[0] * b[1], a[1] * b[0], a[1] * b[1]].map((v) => Math.trunc(v / 65536)); return fits(Math.min(...p), Math.max(...p)); }
      case "fdiv": {
        const [a, b] = r;
        if (b[0] <= 0 && b[1] >= 0) return ANY;
        const q = [a[0] / b[0], a[0] / b[1], a[1] / b[0], a[1] / b[1]].map((v) => Math.trunc(v * 65536));
        return fits(Math.min(...q, 0), Math.max(...q, 0));
      }
      case "sqrt": {
        // sqrt_fixed: the root of a fixed number, a fixed (√raw × 256), 0 below zero; sqrt_whole (unsigned): √x × 65 536
        // of a u32 — a number below zero read so is past 2^30, and gives the largest.
        const hi = e.unsigned ? (nonNeg(r[0]) ? Math.floor(Math.sqrt(r[0][1]) * 65536) : MAX) : r[0][1] <= 0 ? 0 : Math.floor(Math.sqrt(r[0][1]) * 256);
        return [0, Math.min(hi, MAX)];
      }
      case "atan2": return [-FIXED_PI, FIXED_PI];
      case "sin": case "cos": return [-65536, 65536];
      default: return ANY;
    }
  }

  function bool(e: BoolExpr, facts: Facts): void {
    switch (e.kind) {
      case "element": num(e.index, facts); return;
      case "test": num(e.expr, facts); return;
      case "compare": { const l = num(e.left, facts), r = num(e.right, facts); if (annotate) judge(e, l, r); return; }
      case "and": { let f = facts; for (const i of e.items) { bool(i, f); f = withFacts(f, i, true); } return; }
      case "or": { let f = facts; for (const i of e.items) { bool(i, f); f = withFacts(f, i, false); } return; }
      case "not": bool(e.expr, facts); return;
      case "running": num(e.task, facts); return;
      case "unitAlive": unit(e.unit, facts); return;
      case "unitSame": unit(e.left, facts); unit(e.right, facts); return;
      case "unitFlag": unit(e.unit, facts); return;
      case "edge": bool(e.cond, facts); return;
      case "ternary": bool(e.cond, facts); bool(e.whenTrue, withFacts(facts, e.cond, true)); bool(e.whenFalse, withFacts(facts, e.cond, false)); return;
      case "textCompare": case "textTest": mapTextOperands(e, texts(facts)); return;
      case "call": call(e.call, new Map()); return;
      default: return;
    }
  }

  function unit(u: UnitExpr, facts: Facts): void {
    if (u.kind === "unitAt") { num(u.ptr, facts); num(u.epd, facts); num(u.uid, facts); }
    else if (u.kind === "call") call(u.call, new Map());
  }

  /**
   * A comparison whose sides are never below zero is read unsigned (one condition, where a signed one adds to each
   * side), and one the ranges settle — at every place the pass met it — is a constant, when working its sides out
   * does nothing (no call, no pop, no random number).
   */
  const verdicts = new Map<Extract<BoolExpr, { kind: "compare" }>, { truth: boolean | null; nonNeg: boolean }>();
  const judge = (e: Extract<BoolExpr, { kind: "compare" }>, l: Range, r: Range) => {
    const both = nonNeg(l) && nonNeg(r);
    const ok = e.unsigned === true ? both : e.unsigned === "left" ? nonNeg(l) : e.unsigned === "right" ? nonNeg(r) : true;
    const truth = !ok ? null : settle(e.op, l, r);
    const was = verdicts.get(e);
    verdicts.set(e, was ? { truth: was.truth === truth ? truth : null, nonNeg: was.nonNeg && both } : { truth, nonNeg: both });
  };

  let result: VarDecl | undefined;
  function call(c: Call, facts: Facts): void {
    for (const p of c.params) { const r = value(p.decl.kind, p.init, facts); if (p.decl.kind === "number") store(p.decl.id, r); }
    if (c.fn) {
      const r = functions.get(c.fn)?.result?.decl;
      if (c.result?.kind === "number") store(c.result.decl.id, r ? varRange(r.id) : ANY);
      return;
    }
    const saved = result;
    result = c.result?.decl;
    const f = new Map<string, Range>();
    for (const p of c.params) if (p.decl.kind === "number") { const r = vars.get(p.decl.id); if (r) f.set(p.decl.id, r); }
    list(c.body, f);
    result = saved;
  }

  /** A value of a declared kind (a text whatever the kind says, as `valueFor` in numbers.ts); a number's range, else ANY. */
  function value(kind: VarDecl["kind"], v: NumExpr | BoolExpr | UnitExpr | TextExpr, facts: Facts): Range {
    if (isTextExpr(v as { kind: string })) { text(v as TextExpr, facts); return ANY; }
    if (kind === "number") return num(v as NumExpr, facts);
    if (kind === "boolean") bool(v as BoolExpr, facts);
    else unit(v as UnitExpr, facts);
    return ANY;
  }

  /** A store into a number variable: its range, and what is known of it until the next store. */
  const assign = (id: string, r: Range, facts: Facts) => { store(id, r); facts.set(id, r); };

  function list(stmts: Stmt[], facts: Facts): void {
    for (const s of stmts) stmt(s, facts);
  }

  /** What is still known inside a loop (and after it): nothing when it waits or calls, else all but what it stores into. */
  function loop(body: Stmt[][], facts: Facts, cond?: BoolExpr): Facts {
    const { stores, waits } = effects(body.flat());
    if (waits || holdsCall(body, callCache) || (cond && holdsCall(cond, callCache))) { const out = keepPinned(facts); for (const id of stores) out.delete(id); return out; }
    const out = new Map(facts);
    for (const id of stores) out.delete(id);
    return out;
  }

  function stmt(s: Stmt, facts: Facts): void {
    if (!STMT_KINDS.has(s.kind)) { unknown = true; return; }
    if (s.kind !== "if" && s.kind !== "while" && s.kind !== "do" && s.kind !== "for" && s.kind !== "block" && s.kind !== "unrolled" && s.kind !== "switch" && s.kind !== "try" && holdsCall(s, callCache)) forget(facts);
    switch (s.kind) {
      case "declare":
        if (s.failed) { if (s.decl.kind === "number") assign(s.decl.id, ANY, facts); return; }
        { const r = value(s.decl.kind, s.init, facts); if (s.decl.kind === "number") assign(s.decl.id, r, facts); }
        return;
      case "assign": assign(s.target, num(s.value, facts), facts); return;
      case "assignBool": bool(s.value, facts); return;
      case "assignUnit": unit(s.value, facts); return;
      case "assignText": text(s.value, facts); return;
      case "storeText": num(s.index, facts); text(s.value, facts); reached.add(s.addr); reached.add(s.block); reached.add(s.chars); return;
      case "releaseText": num(s.index, facts); reached.add(s.block); return;
      case "textLoop": text(s.of, facts); list(s.body, loop([s.body], facts)); forget(facts); return;
      case "declareArray": {
        const a = arrays.get(s.array);
        for (const v of [...(s.init ?? []), ...(s.fill ? [s.fill] : [])]) {
          if (a?.kind === "number") storeCell(s.array, num(v as NumExpr, facts)); else bool(v as BoolExpr, facts);
        }
        return;
      }
      case "store": case "push": {
        if (s.kind === "store") num(s.index, facts);
        const a = arrays.get(s.array);
        if (a?.kind === "number") storeCell(s.array, num(s.value as NumExpr, facts)); else bool(s.value as BoolExpr, facts);
        return;
      }
      case "pop": return;
      case "setLength": num(s.value, facts); return;
      case "unitLoop": {
        if (s.was) store(s.was.id, ANY);
        const f = loop([s.body], facts);
        if (s.was) f.delete(s.was.id);
        list(s.body, f);
        forget(facts);
        return;
      }
      case "unitWrite": unit(s.unit, facts); if (FLAGS.has(s.field)) bool(s.value as BoolExpr, facts); else num(s.value as NumExpr, facts); return;
      case "unitDo": unit(s.unit, facts); if (s.verb.do === "damage" || s.verb.do === "heal") num(s.verb.amount, facts); return;
      case "tableWrite": if (isTextExpr(s.value as { kind: string })) text(s.value as TextExpr, facts); else if (s.boolean) bool(s.value as BoolExpr, facts); else num(s.value as NumExpr, facts); return;
      case "if": {
        if (holdsCall(s.cond, callCache)) forget(facts);
        bool(s.cond, facts);
        const t = withFacts(facts, s.cond, true), f = withFacts(facts, s.cond, false);
        list(s.then, t);
        if (s.else) list(s.else, f);
        // What both ways leave known; a way that stored into a variable no longer has the fact from before.
        const out = new Map<string, Range>();
        for (const [k, v] of t) { const w = f.get(k); if (w) out.set(k, join(v, w)!); }
        facts.clear();
        for (const [k, v] of out) facts.set(k, v);
        return;
      }
      case "while": {
        const f = loop([s.body], facts, s.cond);
        if (s.cond) bool(s.cond, f);
        list(s.body, s.cond ? withFacts(f, s.cond, true) : f);
        const after = loop([s.body], facts, s.cond);
        facts.clear();
        for (const [k, v] of after) facts.set(k, v);
        return;
      }
      case "do": {
        const f = loop([s.body], facts, s.cond);
        list(s.body, f);
        bool(s.cond, loop([s.body], facts, s.cond));
        facts.clear();
        for (const [k, v] of loop([s.body], f, s.cond)) facts.set(k, v);
        return;
      }
      case "for": {
        const { stores, waits } = effectsOf(s.body);
        const counters = [...effectsOf(s.update).stores].filter((id) => sites.get(id) === 2 && !stores.has(id) && !inTask && !(program.perPlayer && declOf.get(id)?.shared));
        const added = counters.filter((id) => !pinned.has(id));
        for (const id of added) pinned.add(id);
        const f = loop([s.body, s.update], facts, s.cond);
        if (s.cond) bool(s.cond, f);
        const top = s.cond ? withFacts(f, s.cond, true) : f;
        list(s.body, new Map(top));
        // The update, after the body: the test still holds of what the body stored nothing into, unless it waited or
        // called — and of a pinned counter even then.
        const atUpdate = new Map([...top].filter(([k]) => !stores.has(k) && (pinned.has(k) || !(waits || holdsCall(s.body, callCache)))));
        list(s.update, atUpdate);
        for (const id of added) pinned.delete(id);
        const after = loop([s.body, s.update], facts, s.cond);
        facts.clear();
        for (const [k, v] of after) facts.set(k, v);
        return;
      }
      case "unrolled": for (const i of s.iterations) list(i, facts); return;
      case "switch": {
        if (holdsCall(s.value, callCache)) forget(facts);
        num(s.value, facts);
        for (const c of s.cases) list(c.body, new Map());
        facts.clear();
        return;
      }
      case "break": case "continue": case "remark": case "throw": case "uncaught": return;
      case "return":
        if (s.value && result) { const r = value(result.kind, s.value, facts); if (result.kind === "number") store(result.id, r); }
        else if (s.value) eachCall(s.value, (c) => call(c, new Map()));
        return;
      case "sleep": forget(facts); return;
      case "parallel": for (const b of s.branches) list(b, new Map()); forget(facts); return;
      case "start": {
        if (s.handle) assign(s.handle, ANY, facts);
        const was = inTask, saved = [...pinned];
        inTask = true;
        pinned.clear();
        call(s.call, facts);
        inTask = was;
        for (const k of saved) pinned.add(k);
        return;
      }
      case "cancel": num(s.task, facts); return;
      case "action": for (const v of s.variables ?? []) num(v.expr, facts); if (s.text) text(s.text, facts); return;
      case "syncSend": num(s.value, facts); return;
      case "select": for (const u of s.units) unit(u, facts); return;
      case "centerLocation": num(s.x, facts); num(s.y, facts); if (s.size) { num(s.size.width, facts); num(s.size.height, facts); } return;
      case "print": case "buildText": parts(s.parts, facts); return;
      case "call": call(s.call, facts); forget(facts); return;
      case "block": list(s.body, facts); return;
      case "try": list(s.body, new Map(facts)); list(s.catch, new Map()); forget(facts); return;
    }
  }

  const everything = () => {
    result = undefined;
    list(program.body, new Map());
    for (const f of program.functions ?? []) { result = f.result?.decl; list(f.body, new Map()); }
    result = undefined;
  };

  const equal = (a: Map<string, Range>, b: Map<string, Range>) => a.size === b.size && [...a].every(([k, v]) => { const w = b.get(k); return !!w && w[0] === v[0] && w[1] === v[1]; });
  /**
   * The union of what a pass found with what the passes before did (nothing shrinks). Past eight passes a side that
   * still moves goes to its end — `k = (k + 1) & 15` would otherwise creep up one a pass — and the narrowing passes
   * after bring it back: a pass over ranges every store fits in finds ranges every store still fits in.
   */
  const grow = (was: Map<string, Range>, found: Map<string, Range>, pass: number): Map<string, Range> => {
    const out = new Map(was);
    for (const [k, v] of found) {
      const w = was.get(k), j = join(w ?? null, withZero(v))!;
      out.set(k, pass >= 8 && w ? [j[0] < w[0] ? MIN : j[0], j[1] > w[1] ? MAX : j[1]] : j);
    }
    return out;
  };
  const narrow = (was: Map<string, Range>, found: Map<string, Range>): Map<string, Range> => {
    const out = new Map(was);
    for (const [k, w] of was) { const v = found.get(k); out.set(k, v ? meet(w, withZero(v)) : w); }
    return out;
  };
  for (let pass = 0; pass < 48; pass++) {
    next = new Map();
    nextCells = new Map();
    everything();
    if (unknown) break;
    if (!stored) stored = new Set(next.keys());
    const v = grow(vars, next, pass), c = grow(cells, nextCells, pass);
    const done = pass > 0 && equal(vars, v) && equal(cells, c);
    vars = v;
    cells = c;
    if (done) break;
  }
  for (let pass = 0; pass < 4 && !unknown; pass++) {
    next = new Map();
    nextCells = new Map();
    everything();
    const v = narrow(vars, next), c = narrow(cells, nextCells);
    const done = equal(vars, v) && equal(cells, c);
    vars = v;
    cells = c;
    if (done) break;
  }
  if (unknown) return;
  // (Node only: a worker in the browser has no `process`, and reading it there threw — every program failed to compile.)
  if (typeof process !== "undefined" && process.env?.RANGES_DEBUG) for (const [k, v] of vars) if (!isAny(v)) console.log(`ranges ${k} = ${v[0]} … ${v[1]}`);
  annotate = true;
  next = new Map();
  nextCells = new Map();
  everything();
  for (const [e, v] of verdicts) {
    if (v.truth !== null && pure(e.left) && pure(e.right)) {
      for (const k of Object.keys(e)) delete (e as Record<string, unknown>)[k];
      Object.assign(e, { kind: "const", value: v.truth });
    } else if (v.nonNeg && e.unsigned !== true) e.unsigned = true;
  }
}

/** What `a op b` comes to for every pair of values in the two ranges; null when it depends on them. */
function settle(op: string, l: Range, r: Range): boolean | null {
  switch (op) {
    case "<": return l[1] < r[0] ? true : l[0] >= r[1] ? false : null;
    case "<=": return l[1] <= r[0] ? true : l[0] > r[1] ? false : null;
    case ">": return l[0] > r[1] ? true : l[1] <= r[0] ? false : null;
    case ">=": return l[0] >= r[1] ? true : l[1] < r[0] ? false : null;
    case "==": return l[0] === l[1] && r[0] === r[1] && l[0] === r[0] ? true : l[1] < r[0] || r[1] < l[0] ? false : null;
    case "!=": return l[0] === l[1] && r[0] === r[1] && l[0] === r[0] ? false : l[1] < r[0] || r[1] < l[0] ? true : null;
    default: return null;
  }
}

/** Whether working a number out does nothing but give it: no call, no pop, no random number, nothing of a text. */
function pure(e: NumExpr): boolean {
  switch (e.kind) {
    case "const": case "var": case "length": case "read": case "taskHandle": return true;
    case "unitField": case "unitPart": return e.unit.kind === "unitVar" || e.unit.kind === "unitNull";
    case "element": return pure(e.index);
    case "unary": case "cast": return pure(e.expr);
    case "binary": return pure(e.left) && pure(e.right);
    case "intrinsic": return e.args.every(pure);
    default: return false;
  }
}

export type { Range as ValueRange };
