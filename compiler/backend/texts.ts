/**
 * Texts known when the map is built, chosen while the game runs (TrigScript 4, the backend: step 8, part 1). A text
 * whatever it is in the game is one of a few the script wrote — a `?:` of texts, a list of them read at a value, a
 * variable only ever given such texts (`VarDecl.text` "id") — is a number in a map of our own: its place in the
 * script's pool of texts, which the map's strings hold one after another from `base` on, sorted as texts compare. So
 * nothing of it is ever copied: a print of it alone is Display Text of the string its number names; two of them
 * compare as their numbers; what a function of one gives — its length, a search in it, a character, a slice — is
 * worked out for each text it can be when the map is built, and looked up. A printed text with such a text in it is
 * printed once for each text it can be, under a test of which it is. A text made while the game runs is part 2's.
 *
 * `knownTexts` rewrites a program's IR so; what it does not take it leaves as it was, for the emitter to refuse.
 */
import { isTextExpr, programDeclarations, type ArrayDecl, type Call, type FuncDecl, type At, type BoolExpr, type CompareOp, type NumExpr, type Program, type Stmt, type TextExpr, type TextPart, type VarDecl } from "../ir";

/** The most texts one choice may be: past it, part 2's way. */
const MOST_CHOICES = 16;
/** The most times a printed text is printed, once for each text it can be; past it, its choices are written byte by byte. */
const MOST_PRINTS = 4;
/** The most cells a table of what a function of a text gives at each value of a number may have. */
const MOST_CELLS = 512;

/** Texts compared as the simulator compares them: character by character, by their numbers. */
export function compareTexts(a: string, b: string): number {
  const x = [...a], y = [...b];
  for (let i = 0; i < x.length && i < y.length; i++) {
    const d = x[i].codePointAt(0)! - y[i].codePointAt(0)!;
    if (d) return d;
  }
  return x.length - y.length;
}

/**
 * The script's texts that a program chooses between while the game runs, numbered once all are known: sorted as texts
 * compare, so that a number's order is its text's. The constants and the cells of tables that hold a text's number are
 * filled in then.
 */
export class TextPool {
  private readonly refs: { node: { value: number }; text: string }[] = [];
  private readonly tables: { values: number[]; texts: (string | null)[] }[] = [];
  private done: string[] | null = null;

  /** A text's number, as a constant of the IR filled in by `finish`. */
  id(text: string): NumExpr {
    if (this.done) throw new Error("the pool of texts is finished");
    const node = { kind: "const" as const, value: 0 };
    this.refs.push({ node, text });
    return node;
  }

  /** Cells holding texts' numbers (a cell of `null` keeps its value), filled in by `finish`. */
  table(values: number[], texts: (string | null)[]): void {
    this.tables.push({ values, texts });
  }

  get size(): number {
    return new Set([...this.refs.map((r) => r.text), ...this.tables.flatMap((t) => t.texts.filter((x): x is string => x !== null))]).size;
  }

  /** The texts in the order of their numbers. */
  finish(): string[] {
    if (this.done) return this.done;
    const all = [...new Set([...this.refs.map((r) => r.text), ...this.tables.flatMap((t) => t.texts.filter((x): x is string => x !== null))])].sort(compareTexts);
    const index = new Map(all.map((t, i) => [t, i]));
    for (const r of this.refs) r.node.value = index.get(r.text)!;
    for (const t of this.tables) t.texts.forEach((x, i) => { if (x !== null) t.values[i] = index.get(x)!; });
    return (this.done = all);
  }
}

/**
 * A text that is one of `texts` in the game: `expr` is its number in the pool. `over`: it is the `index`-th of
 * `results`, a table's, read at a value (what a function of a text known when built gives at a variable).
 */
interface Choice { expr: NumExpr; texts: string[]; over?: { index: NumExpr; results: string[] } }

const k = (value: number): NumExpr => ({ kind: "const", value });
const chars = (s: string) => [...s];

/** A number worked out from the values of the variables it reads, when it is of the few kinds this knows. */
function evaluate(e: NumExpr, env: Map<string, number>): number | undefined {
  switch (e.kind) {
    case "const": return e.fixed ? undefined : e.value;
    case "var": return env.get(e.id);
    case "unary": { const x = evaluate(e.expr, env); return x === undefined ? undefined : -x | 0; }
    case "binary": {
      const a = evaluate(e.left, env), b = evaluate(e.right, env);
      if (a === undefined || b === undefined || e.unsigned) return undefined;
      switch (e.op) {
        case "+": return (a + b) | 0;
        case "-": return (a - b) | 0;
        case "*": return Math.imul(a, b);
        default: return undefined;
      }
    }
    case "intrinsic": {
      if (e.unsigned) return undefined;
      const xs = e.args.map((x) => evaluate(x, env));
      if (xs.some((x) => x === undefined)) return undefined;
      const v = xs as number[];
      return e.name === "min" ? Math.min(...v) : e.name === "max" ? Math.max(...v) : e.name === "abs" ? Math.abs(v[0]) | 0 : undefined;
    }
    case "ternary": {
      const c = test(e.cond, env);
      return c === undefined ? undefined : evaluate(c ? e.whenTrue : e.whenFalse, env);
    }
    default: return undefined;
  }
}

function test(e: BoolExpr, env: Map<string, number>): boolean | undefined {
  switch (e.kind) {
    case "const": return e.value;
    case "not": { const x = test(e.expr, env); return x === undefined ? undefined : !x; }
    case "compare": {
      if (e.unsigned) return undefined;
      const a = evaluate(e.left, env), b = evaluate(e.right, env);
      if (a === undefined || b === undefined) return undefined;
      return compare(e.op, a, b);
    }
    default: return undefined;
  }
}

const compare = (op: CompareOp, a: number, b: number) => (op === "==" ? a === b : op === "!=" ? a !== b : op === "<" ? a < b : op === "<=" ? a <= b : op === ">" ? a > b : a >= b);

/** The variables a number reads, or null when it reads anything else of the game's or the program's. */
function readsOf(e: NumExpr, out = new Set<string>()): Set<string> | null {
  switch (e.kind) {
    case "const": return out;
    case "var": out.add(e.id); return out;
    case "unary": return readsOf(e.expr, out);
    case "binary": return readsOf(e.left, out) && readsOf(e.right, out);
    case "intrinsic": return e.args.every((x) => readsOf(x, out)) ? out : null;
    case "ternary": return boolReads(e.cond, out) && readsOf(e.whenTrue, out) && readsOf(e.whenFalse, out);
    default: return null;
  }
}
function boolReads(e: BoolExpr, out: Set<string>): Set<string> | null {
  switch (e.kind) {
    case "const": return out;
    case "not": return boolReads(e.expr, out);
    case "compare": return readsOf(e.left, out) && readsOf(e.right, out);
    default: return null;
  }
}

/**
 * The values of a variable where numbers of it can be inside `-span … span`: for every part of them that is a line of
 * the variable (worked out at a few values), the values that put it there, all of them together, a value either side.
 * Null when no part is a line of it, or one is too steep to say.
 */
function windowOf(nums: (NumExpr | undefined)[], v: string, span: number): [number, number] | null {
  let lo = Infinity, hi = -Infinity;
  const look = (x: unknown): void => {
    if (Array.isArray(x)) { x.forEach(look); return; }
    if (!x || typeof x !== "object") return;
    const e = x as NumExpr;
    if (typeof e.kind === "string" && e.kind !== "const") {
      const f = (t: number) => evaluate(e, new Map([[v, t]]));
      const b = f(0), a = f(1) === undefined || b === undefined ? undefined : f(1)! - b;
      if (a !== undefined && a !== 0 && [-1000, -7, 3, 1000].every((t) => f(t) === ((b! + a * t) | 0))) {
        const ends = [(-span - b!) / a, (span - b!) / a];
        lo = Math.min(lo, Math.floor(Math.min(...ends)) - 1);
        hi = Math.max(hi, Math.ceil(Math.max(...ends)) + 1);
      }
    }
    for (const y of Object.values(x)) if (y && typeof y === "object") look(y);
  };
  look(nums);
  return lo <= hi && hi - lo < 4096 ? [lo, hi] : null;
}

/** The values a variable can have, as the front end's ranges say where the numbers read it (`[lowest, highest]`). */
function rangeOf(nums: (NumExpr | undefined)[], id: string): [number, number] | undefined {
  let out: [number, number] | undefined;
  const look = (x: unknown): void => {
    if (Array.isArray(x)) { x.forEach(look); return; }
    if (!x || typeof x !== "object") return;
    const o = x as { kind?: string; id?: string; range?: [number, number] };
    if (o.kind === "var" && o.id === id && o.range) out = out ? [Math.max(out[0], o.range[0]), Math.min(out[1], o.range[1])] : [o.range[0], o.range[1]];
    for (const v of Object.values(o)) if (v && typeof v === "object") look(v);
  };
  look(nums);
  return out && out[0] <= out[1] ? out : undefined;
}

/** A number with each scratch variable the front end declared just before it (`decl.temp`) seen through. */
function through(e: NumExpr, temps: Map<string, NumExpr>): NumExpr {
  const map = (x: unknown): unknown => {
    if (Array.isArray(x)) return x.map(map);
    if (!x || typeof x !== "object") return x;
    const o = x as { kind?: string; id?: string };
    if (o.kind === "var" && temps.has(o.id!)) return map(temps.get(o.id!));
    return Object.fromEntries(Object.entries(o).map(([key, v]) => [key, map(v)]));
  };
  return map(e) as NumExpr;
}

/**
 * Rewrites a program's texts known when built as numbers of `pool`; `base` is the string the pool's first text is
 * among the map's. Gives back the program as rewritten (its arrays, the tables' too).
 */
export function knownTexts(program: Program, pool: TextPool, base: number): Program {
  // (Every declaration, a call's parameters and result among them, wherever the call is.)
  const decls = new Map(programDeclarations(program).map((d) => [d.id, d]));
  const deep = (x: unknown): void => {
    if (Array.isArray(x)) { x.forEach(deep); return; }
    if (!x || typeof x !== "object") return;
    const o = x as { decl?: VarDecl };
    if (o.decl && typeof o.decl === "object" && typeof o.decl.id === "string" && !decls.has(o.decl.id)) decls.set(o.decl.id, o.decl);
    for (const v of Object.values(o)) if (v && typeof v === "object") deep(v);
  };
  deep(program);
  const arrays: ArrayDecl[] = [...(program.arrays ?? [])];
  const arrayById = new Map(arrays.map((a) => [a.id, a]));
  let n = 0;
  const fresh = (what: string) => `@text.${what}${n++}`;
  // (A scratch variable the front end declares just before the text that reads it, `(index)` = i + 4: what it was
  // set to, so that a table can be of the one variable both read.)
  const temps = new Map<string, NumExpr>();

  // The texts each variable of known texts is ever given: what its declaration and its assignments are, until no
  // more come in (one may be given another's).
  const idVars = new Map<string, Set<string>>();
  for (const d of decls.values()) if (d.kind === "text" && d.text === "id") idVars.set(d.id, new Set());
  const writes: { target: string; value: TextExpr }[] = [];
  const collect = (x: unknown): void => {
    if (Array.isArray(x)) { x.forEach(collect); return; }
    if (!x || typeof x !== "object") return;
    const o = x as Record<string, unknown>;
    if (o.kind === "declare" && idVars.has((o.decl as VarDecl).id)) writes.push({ target: (o.decl as VarDecl).id, value: o.init as TextExpr });
    if (o.kind === "assignText" && idVars.has(o.target as string)) writes.push({ target: o.target as string, value: o.value as TextExpr });
    for (const v of Object.values(o)) if (v && typeof v === "object") collect(v);
  };
  collect([program.body, program.functions ?? []]);
  const possible = (t: TextExpr): string[] | null => {
    switch (t.kind) {
      case "text": return [t.text];
      case "textVar": return idVars.has(t.id) ? [...idVars.get(t.id)!] : null;
      case "textTernary": { const a = possible(t.whenTrue), b = possible(t.whenFalse); return a && b ? [...a, ...b] : null; }
      case "textOf": { const a = arrayById.get(t.array); return a?.texts ? [...a.texts] : null; }
      default: return null;
    }
  };
  for (let grew = true; grew;) {
    grew = false;
    for (const w of writes) {
      const s = idVars.get(w.target)!;
      for (const t of possible(w.value) ?? []) if (!s.has(t)) { s.add(t); grew = true; }
    }
  }
  // (A variable given a text it cannot know is the emitter's to refuse: its texts stay unknown.)
  for (const w of writes) if (!possible(w.value)) idVars.delete(w.target);

  /** A text's choice, its numbers and conditions rewritten; null when it is not one of texts known when built. */
  const choice = (t: TextExpr): Choice | null => {
    switch (t.kind) {
      case "text": return { expr: pool.id(t.text), texts: [t.text] };
      case "textVar": {
        const s = idVars.get(t.id);
        return s ? { expr: { kind: "var", id: t.id }, texts: [...s] } : null;
      }
      case "textTernary": {
        const a = choice(t.whenTrue), b = choice(t.whenFalse);
        if (!a || !b) return null;
        const texts = [...new Set([...a.texts, ...b.texts])];
        if (texts.length > MOST_CHOICES) return null;
        return { expr: { kind: "ternary", cond: bool(t.cond), whenTrue: a.expr, whenFalse: b.expr, at: t.at, label: t.label }, texts };
      }
      case "textOf": {
        const a = arrayById.get(t.array);
        if (!a?.texts || !a.values) return null;
        // (A list of the texts' numbers in the pool, read at the index.)
        const id = `${a.id}@texts`;
        if (!arrayById.has(id)) {
          const values = a.values.map(() => 0);
          pool.table(values, a.values.map((v) => a.texts![v] ?? ""));
          const decl: ArrayDecl = { id, name: a.name, kind: "number", length: values.length, shared: true, values, at: a.at };
          arrays.push(decl);
          arrayById.set(id, decl);
        }
        return { expr: { kind: "element", array: id, index: num(t.index), at: t.at }, texts: [...new Set(a.texts)] };
      }
      case "textSlice": {
        const of = choice(t.of);
        if (!of) return null;
        return made(of, [t.start, t.end], ([s], [start, end]) => {
          const c = chars(s);
          const a = start === undefined ? 0 : Math.min(c.length, Math.max(0, start)), b = end === undefined ? c.length : Math.min(c.length, Math.max(0, end));
          return c.slice(a, Math.max(a, b)).join("");
        }, t.at);
      }
      default: return null;
    }
  };

  /**
   * What `f` gives — a number, or a text — of the texts `of` and the numbers `nums` (absent: undefined), worked out
   * when built: for each text the one choice can be, the numbers known; or, the texts one each, for each value of
   * the one variable the numbers read. Null when there is more to it than that.
   */
  const table = <R extends number | string>(of: Choice[], nums: (NumExpr | undefined)[], f: (texts: string[], nums: (number | undefined)[]) => R, at: At): { expr: NumExpr; results: R[]; index?: NumExpr } | null => {
    const many = of.filter((c) => c.texts.length > 1);
    const known = nums.map((x) => (x === undefined ? undefined : evaluate(x, new Map())));
    const fixed = nums.every((x, i) => x === undefined || known[i] !== undefined);
    const value = (r: R): NumExpr => (typeof r === "string" ? pool.id(r) : k(r));
    if (!many.length && fixed) {
      const r = f(of.map((c) => c.texts[0]), known);
      return { expr: value(r), results: [r] };
    }
    if (many.length === 1 && fixed) {
      // One choice: a test of which text it is, for each but the last.
      const c = many[0];
      if (c.texts.length > MOST_CHOICES) return null;
      const results = c.texts.map((s) => f(of.map((x) => (x === c ? s : x.texts[0])), known));
      let expr = value(results[results.length - 1]);
      for (let i = results.length - 2; i >= 0; i--) expr = { kind: "ternary", cond: { kind: "compare", op: "==", left: c.expr, right: pool.id(c.texts[i]), at, label: "" }, whenTrue: value(results[i]), whenFalse: expr, at, label: "" };
      return { expr, results };
    }
    if (many.length === 1 && many[0].texts.length <= MOST_CHOICES) {
      // One choice, and numbers that read a variable: for each text it can be, a table of the variable (below), the one
      // its text is picked by a test of which it is.
      const c = many[0];
      const each = c.texts.map((s) => table(of.map((x) => (x === c ? { expr: pool.id(s), texts: [s] } : x)), nums, f, at));
      if (each.some((t) => !t)) return null;
      let expr = each[each.length - 1]!.expr;
      for (let i = each.length - 2; i >= 0; i--) expr = { kind: "ternary", cond: { kind: "compare", op: "==", left: c.expr, right: pool.id(c.texts[i]), at, label: "" }, whenTrue: each[i]!.expr, whenFalse: expr, at, label: "" };
      return { expr, results: each.flatMap((t) => t!.results) };
    }
    if (many.length) return null;
    // The texts known; the numbers read one variable: a table of what f gives at each of its values, as far as it
    // changes, read at the variable held between the table's ends.
    nums = nums.map((x) => (x ? through(x, temps) : x));
    const reads = new Set<string>();
    for (const x of nums) if (x && !readsOf(x, reads)) return null;
    if (reads.size !== 1) return null;
    const [v] = reads;
    const texts = of.map((c) => c.texts[0]);
    const at_ = (i: number) => { const env = new Map([[v, i]]); return f(texts, nums.map((x) => (x === undefined ? undefined : evaluate(x, env)))); };
    // Where it can change: where each part of the numbers that moves with the variable as a line does (`c - 97`) is
    // within the texts' lengths, and a little more; past those it is the same as at their ends.
    const span = Math.max(...texts.map((s) => chars(s).length)) + 2;
    const window = windowOf(nums, v, span);
    if (!window) return null;
    let [lo, hi] = window;
    if (at_(lo) !== at_(lo - 1000) || at_(hi) !== at_(hi + 1000) || at_(lo) !== at_(lo - 1) || at_(hi) !== at_(hi + 1)) return null;
    while (lo < hi && at_(lo + 1) === at_(lo)) lo++;
    while (hi > lo && at_(hi - 1) === at_(hi)) hi--;
    // (Within the values the variable can have, when the front end's ranges know them.)
    const range = rangeOf(nums, v);
    if (range) { lo = Math.max(lo, range[0]); hi = Math.max(lo, Math.min(hi, range[1])); }
    if (hi - lo + 1 > MOST_CELLS) return null;
    const results: R[] = [];
    for (let i = lo; i <= hi; i++) results.push(at_(i));
    const id = fresh("table");
    const values = results.map((r) => (typeof r === "number" ? r : 0));
    if (results.some((r) => typeof r === "string")) pool.table(values, results.map((r) => (typeof r === "string" ? r : null)));
    arrays.push({ id, name: id, kind: "number", length: values.length, shared: true, values, at });
    // (The variable held between lo and hi, as a value of the table's place: lo from it.)
    const held: NumExpr = { kind: "intrinsic", name: "max", args: [k(lo), { kind: "intrinsic", name: "min", args: [{ kind: "var", id: v }, k(hi)], at, label: "" }], at, label: "" };
    const index: NumExpr = { kind: "binary", op: "-", left: held, right: k(lo), at, label: "" };
    return { expr: { kind: "element", array: id, index, at }, results, index };
  };
  const made = (of: Choice, nums: (NumExpr | undefined)[], f: (texts: string[], nums: (number | undefined)[]) => string, at: At): Choice | null => {
    const t = table([of], nums.map((x) => (x ? num(x) : undefined)), f, at);
    if (!t) return null;
    return { expr: t.expr, texts: [...new Set(t.results)], ...(t.index ? { over: { index: t.index, results: t.results } } : {}) };
  };

  const num = (e: NumExpr): NumExpr => {
    switch (e.kind) {
      case "textLength": {
        if (e.of.kind === "textVar" && madeVars.has(e.of.id)) return V(madeVars.get(e.of.id)!.c);
        const of = choice(e.of);
        const t = of && table([of], [], ([s]) => chars(s).length, e.at);
        return t ? t.expr : e;
      }
      case "textIndexOf": {
        const of = choice(e.of), find = choice(e.find);
        if (!of || !find) return e;
        const t = table([of, find], [e.from ? num(e.from) : undefined], ([s, f], [from]) => {
          const c = chars(s), start = Math.max(0, from ?? 0);
          const i = s.indexOf(f, c.slice(0, start).join("").length);
          return i < 0 || start > c.length ? (f === "" && start <= c.length ? start : -1) : chars(s.slice(0, i)).length;
        }, e.at);
        return t ? t.expr : e;
      }
      case "textCode": {
        const of = choice(e.of);
        const t = of && table([of], [num(e.index)], ([s], [i]) => chars(s)[i!]?.codePointAt(0) ?? -1, e.at);
        return t ? t.expr : e;
      }
      default: return copy(e) as NumExpr;
    }
  };
  const bool = (e: BoolExpr): BoolExpr => {
    switch (e.kind) {
      case "textCompare": {
        const a = choice(e.left), b = choice(e.right);
        // A made text and a known one, the same or not.
        const mv = (t: TextExpr) => (t.kind === "textVar" ? madeVars.get(t.id) : undefined);
        const [m, known] = mv(e.left) && b?.texts.length === 1 ? [mv(e.left), b.texts[0]] : mv(e.right) && a?.texts.length === 1 ? [mv(e.right), a.texts[0]] : [undefined, undefined];
        if (m && known !== undefined && (e.op === "==" || e.op === "!=")) return equalsKnown(m, known, e.op);
        if (!a || !b) return e;
        // (Numbered as their texts compare: the same text, the same number.)
        return { kind: "compare", op: e.op, left: a.expr, right: b.expr, at: e.at, label: e.label };
      }
      case "textTest": {
        const of = choice(e.of), find = choice(e.find);
        const t = of && find && table([of, find], [], ([s, f]) => (e.test === "startsWith" ? s.startsWith(f) : e.test === "endsWith" ? s.endsWith(f) : s.includes(f)) ? 1 : 0, e.at);
        return t ? { kind: "compare", op: "==", left: t.expr, right: k(1), at: e.at, label: e.label } : e;
      }
      default: return copy(e) as BoolExpr;
    }
  };

  /**
   * Anything else with every number, condition and statement inside it rewritten: a list of statements as statements,
   * a number or a condition of a text as one (`num`, `bool`), anything else field by field.
   */
  const NUMS = new Set(["textLength", "textIndexOf", "textCode"]), BOOLS = new Set(["textCompare", "textTest"]);
  const walk = (x: unknown): unknown => {
    if (Array.isArray(x)) return x.length && isStmt(x[0]) ? stmts(x as Stmt[]) : x.map(walk);
    if (!x || typeof x !== "object") return x;
    const kind = (x as { kind?: unknown }).kind;
    if (typeof kind === "string" && NUMS.has(kind)) return num(x as NumExpr);
    if (typeof kind === "string" && BOOLS.has(kind)) return bool(x as BoolExpr);
    return copy(x);
  };
  const copy = (x: unknown): unknown => {
    const out: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(x as Record<string, unknown>)) out[key] = v && typeof v === "object" ? walk(v) : v;
    return out;
  };


  // ── Texts made while the game runs (part 2) ──
  //
  // A made text variable has a block of its own — a string of the map's, so that printing it alone is Display Text of
  // it as it is — and two numbers beside it: its length in bytes and in characters. Its block's EPD is a variable set
  // once where it is declared (`textBlock`). A text is made at the program's one cursor — a dword (an EPD), the byte in
  // it, and the bytes and characters written — from a block's start: a known text's bytes as constant writes (one test
  // of the byte the cursor is at), anything else by the run time's functions, laid out once for the program and called
  // (`fn`): another text's dwords copied whole, a number's digits, one byte. What a text needs made first — a call's
  // result, a text read from — is made before the text it is in is begun, so that one text is made at a time.
  interface Made { e: string; n: string; c: string; block: string }
  const madeVars = new Map<string, Made>();
  for (const d of decls.values()) if (d.kind === "text" && d.text === "made") madeVars.set(d.id, { e: `${d.id}@e`, n: `${d.id}@n`, c: `${d.id}@c`, block: `${d.id}@block` });
  const SCRATCH: Made = { e: "@text.scratch@e", n: "@text.scratch@n", c: "@text.scratch@c", block: "@text.scratch" };
  let here: At = { file: "", line: 0, column: 0 };
  const V = (id: string): NumExpr => ({ kind: "var", id });
  const bin = (op: "+" | "-" | "*" | "&" | ">>>", a: NumExpr, b: NumExpr): NumExpr => ({ kind: "binary", op, left: a, right: b, at: here, label: "" });
  const cmp = (op: CompareOp, a: NumExpr, b: NumExpr, unsigned = false): BoolExpr => ({ kind: "compare", op, left: a, right: b, ...(unsigned ? { unsigned: true } : {}), at: here, label: "" });
  const set = (target: string, value: NumExpr): Stmt => ({ kind: "assign", target, value, at: here, label: "" });
  const add = (target: string, n: NumExpr | number): Stmt => set(target, bin("+", V(target), typeof n === "number" ? k(n) : n));
  const dec = (id: string, init: NumExpr, routed = false): Stmt => ({ kind: "declare", decl: { id, name: "(text)", kind: "number", shared: false, at: here, ...(routed ? { routed: true } : {}) }, init, at: here, label: "" });
  const when = (cond: BoolExpr, then: Stmt[], otherwise?: Stmt[]): Stmt => ({ kind: "if", cond, then, ...(otherwise?.length ? { else: otherwise } : {}), at: here, label: "" });
  const loop = (cond: BoolExpr, body: Stmt[]): Stmt => ({ kind: "while", cond, body, at: here, label: "" });
  const all = (...items: BoolExpr[]): BoolExpr => ({ kind: "and", items });
  const any = (...items: BoolExpr[]): BoolExpr => ({ kind: "or", items });
  const u32 = (n: number) => ((n % 2 ** 32) + 2 ** 32) % 2 ** 32;
  const ranged = (e: NumExpr, lo: number, hi: number): NumExpr => ({ ...e, range: [lo, hi] }) as unknown as NumExpr;
  /** The bytes `from` to `to` (0 to 3) of a dword, as a mask. */
  const bytesMask = (from: number, to: number) => { let m = 0; for (let j = from; j <= to; j++) m += 0xff * 2 ** (8 * j); return m; };
  /** A Set Deaths of the dword at an EPD: the value written, or its bits of the mask. */
  const poke = (epd: NumExpr, value: NumExpr, mask?: number): Stmt => {
    const whole = mask === undefined || u32(mask) === 0xffffffff;
    const record = { location: whole ? 0 : u32(mask!), text: 0, wav: 0, time: 0, player: 0, target: value.kind === "const" ? u32(value.value) : 0, unitId: 0, type: 45, modifier: 7, flags: 0, padding: 0, mask: whole ? 0 : 0x4353 };
    const variables = [{ field: "player" as const, bits: 32 as const, name: "at", expr: epd }, ...(value.kind === "const" ? [] : [{ field: "target" as const, bits: 32 as const, name: "n", expr: value }])];
    return { kind: "action", record, variables, at: here, label: "" };
  };
  /** The dword at an EPD, or its bits of the mask moved down `shift` (up, below 0). */
  const peek = (epd: NumExpr, mask?: number, shift = 0): NumExpr => {
    const whole = mask === undefined;
    const r: NumExpr = { kind: "read", read: { source: "condition", record: { location: whole ? 0 : u32(mask!), player: 0, amount: 0, unitId: 0, comparison: 0, type: 15, resource: 0, flags: 0, mask: whole ? 0 : 0x4353 }, epd }, at: here, label: "" } as NumExpr;
    if (shift > 0) return { kind: "binary", op: ">>>", left: r, right: k(shift), at: here, label: "" };
    if (shift < 0) return { kind: "binary", op: "*", left: r, right: k(2 ** -shift), at: here, label: "" };
    return r;
  };
  /** One of four statement lists by the byte a cursor is at (0 to 3). */
  const byByte = (at: string, each: (o: number) => Stmt[]): Stmt => when(cmp("==", V(at), k(0)), each(0), [when(cmp("==", V(at), k(1)), each(1), [when(cmp("==", V(at), k(2)), each(2), each(3))])]);
  /** The byte at a dword and a byte of it, into a variable. */
  const readByte = (target: string, e: string, o: string): Stmt => byByte(o, (b) => [set(target, peek(V(e), 0xff * 2 ** (8 * b), 8 * b))]);
  /** Whether a byte starts a character (UTF-8: not 10xxxxxx). */
  const starts = (b: string): BoolExpr => any(cmp("<", V(b), k(0x80), true), cmp(">=", V(b), k(0xc0), true));
  const enc = new TextEncoder();
  /** The most a known text written at once may run past a made text's most: the room a block has after it. */
  const SLACK = 256;
  const BLOCK = TEXT_BYTES + 1 + SLACK;

  // The run time: its variables, one of each for the program (declared at its start), and its functions.
  const globals = new Set<string>();
  const G = (name: string) => { const id = `@t.${name}`; globals.add(id); return id; };
  const CE = G("ce"), CO = G("co"), CN = G("cn"), CC = G("cc"), B = G("b"), SE = G("se"), SN = G("sn"), SC = G("sc"), RV = G("rv");
  const runtime = new Map<string, FuncDecl | null>();
  /** A call of the run time's function `name`, its body made the first time it is called. */
  const fn = (name: string, body: () => Stmt[]): Stmt => {
    const id = `@text.fn.${name}`;
    if (!runtime.has(id)) {
      runtime.set(id, null);
      const at = here;
      runtime.set(id, { id, name: id, params: [], body: body(), at });
    }
    return { kind: "call", call: { fn: id, name: id, at: here, label: "", params: [], body: [] }, at: here, label: "" } as Stmt;
  };
  /** The cursor at a block's start. */
  const begin = (e: NumExpr): Stmt[] => [set(CE, e), set(CO, k(0)), set(CN, k(0)), set(CC, k(0))];
  /**
   * A known text's bytes at the cursor: copied from a block of the program's that holds it (one a text), as a made
   * text's are — the cursor read in the run time's functions alone, not wherever a text is written.
   */
  const known = new Map<string, string>();
  const writeConst = (text: string): Stmt[] | null => {
    const b = enc.encode(text).length;
    if (!b) return [];
    if (!known.has(text)) known.set(text, `@text.known${known.size}`);
    const id = known.get(text)!;
    return [set(SE, V(`${id}@e`)), set(SN, k(b)), set(SC, k(chars(text).length)), copyText()];
  };
  /** The byte in `B` at the cursor, the cursor on past it (a variable for each byte of a dword it may go in). */
  const put = (): Stmt => fn("put", () => [
    byByte(CO, (o) => {
      if (!o) return [poke(V(CE), V(B), 0xff)];
      const b = G(`b${o}`);
      return [set(b, ranged(V(B), 0, 255)), poke(V(CE), bin("*", V(b), k(2 ** (8 * o))), 0xff * 2 ** (8 * o))];
    }),
    add(CO, 1),
    when(cmp("==", V(CO), k(4)), [set(CO, k(0)), add(CE, 1)]),
    add(CN, 1),
  ]);
  /** A character of one byte (a value) at the cursor. */
  const putChar = (byte: NumExpr): Stmt[] => [set(B, byte), put(), add(CC, 1)];
  /**
   * The made text at `SE` (`SN` bytes, `SC` characters) at the cursor, no more than a made text holds: its dwords whole
   * when the cursor is at a dword's start; else each dword read once, as two masked reads that put its bytes where they
   * go in the two dwords it falls in. What runs past its end is written over, or is past the 0 the text ends with.
   */
  const copyText = (): Stmt => fn("copy", () => {
    const n = G("n"), w = G("w"), p = G("p"), q = G("q"), i = G("i"), lo = G("lo"), hi = G("hi"), d = G("d"), pos = G("pos");
    const step = [add(p, 1), add(q, 1), add(i, 1)];
    return [
      set(n, V(SN)),
      when(cmp(">=", V(CN), k(TEXT_BYTES)), [set(n, k(0))], [when(cmp(">", V(n), bin("-", k(TEXT_BYTES), V(CN)), true), [set(n, bin("-", k(TEXT_BYTES), V(CN)))])]),
      set(w, bin(">>>", bin("+", V(n), k(3)), k(2))),
      set(p, V(SE)), set(q, V(CE)), set(i, k(0)),
      byByte(CO, (o) => o === 0
        ? [loop(cmp("<", V(i), V(w)), [set(d, peek(V(p))), poke(V(q), V(d)), ...step])]
        : [loop(cmp("<", V(i), V(w)), [
          set(lo, peek(V(p), 2 ** (32 - 8 * o) - 1, -8 * o)),
          set(hi, peek(V(p), u32(-(2 ** (32 - 8 * o))), 32 - 8 * o)),
          poke(V(q), V(lo), bytesMask(o, 3)),
          poke(bin("+", V(q), k(1)), V(hi), bytesMask(0, o - 1)),
          ...step,
        ])]),
      set(pos, bin("+", V(CO), V(n))),
      add(CE, bin(">>>", V(pos), k(2))),
      set(CO, bin("&", V(pos), k(3))),
      add(CN, V(n)),
      add(CC, V(SC)),
    ];
  });
  /** A made text at the cursor. */
  const writeMade = (m: Made): Stmt[] => [set(SE, V(m.e)), set(SN, V(m.n)), set(SC, V(m.c)), copyText()];
  /** A number's digits at the cursor (`X`), with its minus sign unless `unsigned`: from 10^9 down, 8, 4, 2, 1 off. */
  const X = G("x");
  const number = (unsigned: boolean): Stmt => fn(unsigned ? "unumber" : "number", () => {
    const r = G("r"), started = G("started"), d = G("d10");
    const out: Stmt[] = [set(r, V(X)), set(started, k(0))];
    if (!unsigned) out.push(when(cmp("<", V(r), k(0)), [...writeConst("-")!, set(r, bin("-", k(0), V(r)))]));
    for (let p = 9; p >= 0; p--) {
      out.push(set(d, k(48)));
      for (const m of [8, 4, 2, 1]) {
        const step = m * 10 ** p;
        if (step >= 2 ** 32) continue;
        out.push(when(cmp(">=", V(r), k(u32(step) | 0), true), [set(r, bin("-", V(r), k(step | 0))), add(d, m)]));
      }
      const digit = putChar(V(d));
      out.push(p ? when(any(cmp(">=", V(d), k(49)), cmp(">=", V(started), k(1))), [set(started, k(1)), ...digit]) : digit[0], ...(p ? [] : digit.slice(1)));
    }
    return out;
  });
  /** The 0 after a made text — at its most, which cuts it there, when it ran past — the rest of its dword 0s too. */
  const BLK = G("blk");
  const end = (): Stmt => fn("end", () => [
    when(cmp(">", V(CN), k(TEXT_BYTES), true), [set(CN, k(TEXT_BYTES)), set(CC, k(TEXT_BYTES)), poke(bin("+", V(BLK), k(TEXT_BYTES >> 2)), k(0), u32(-(2 ** (8 * (TEXT_BYTES & 3)))))], [
      byByte(CO, (o) => [poke(V(CE), k(0), u32(-(2 ** (8 * o))))]),
    ]),
  ]);
  /** The text being made ended, its lengths into `into`. */
  const finish = (into: Made): Stmt[] => [set(BLK, V(into.e)), end(), set(into.n, V(CN)), set(into.c, V(CC))];
  /** A reader of a made text's bytes: the dword, the byte, how many read, the byte read. */
  interface Reader { se: string; so: string; i: string; b: string }
  const reader = (names: Reader, m: { e: NumExpr }): Stmt[] => [set(names.se, m.e), set(names.so, k(0)), set(names.i, k(0)), set(names.b, k(0))];
  /** The reader's byte into its `b`, and the reader on past it. */
  const next = (r: Reader): Stmt[] => [readByte(r.b, r.se, r.so), add(r.so, 1), when(cmp("==", V(r.so), k(4)), [set(r.so, k(0)), add(r.se, 1)]), add(r.i, 1)];
  const R: Reader = { se: G("re"), so: G("ro"), i: G("ri"), b: G("rb") };
  const LO = G("slo"), HI = G("shi");
  /**
   * Characters `LO` up to `HI` of the made text at `SE` at the cursor. Of one byte a character, the bytes from `LO`
   * read and put; any other walked, a character counted at each byte that starts one.
   */
  const slice = (): Stmt => fn("slice", () => {
    const ci = G("ci"), lo = G("lo2"), hi = G("hi2");
    return [
      set(lo, { kind: "intrinsic", name: "min", args: [{ kind: "intrinsic", name: "max", args: [V(LO), k(0)], at: here, label: "" }, V(SC)], at: here, label: "" } as NumExpr),
      set(hi, { kind: "intrinsic", name: "min", args: [{ kind: "intrinsic", name: "max", args: [V(HI), V(lo)], at: here, label: "" }, V(SC)], at: here, label: "" } as NumExpr),
      when(cmp("==", V(SC), V(SN)), [
        set(R.se, bin("+", V(SE), bin(">>>", V(lo), k(2)))), set(R.so, bin("&", V(lo), k(3))), set(R.i, V(lo)),
        loop(all(cmp("<", V(R.i), V(hi)), cmp("<", V(CN), k(TEXT_BYTES), true)), [...next(R), set(B, V(R.b)), put(), add(CC, 1)]),
      ], [
        ...reader(R, { e: V(SE) }), set(ci, k(-1)),
        loop(all(cmp("<", V(R.i), V(SN), true), cmp("<", V(CN), k(TEXT_BYTES), true)), [
          ...next(R),
          when(starts(R.b), [add(ci, 1)]),
          when(all(cmp(">=", V(ci), V(lo)), cmp("<", V(ci), V(hi))), [set(B, V(R.b)), put(), when(starts(R.b), [add(CC, 1)])]),
        ]),
      ]),
    ];
  });
  /** Characters `from` up to `to` (absent: to its end) of a made text at the cursor. */
  const writeSlice = (src: Made, from: NumExpr, to: NumExpr | undefined): Stmt[] => [set(SE, V(src.e)), set(SN, V(src.n)), set(SC, V(src.c)), set(LO, from), set(HI, to ?? V(src.c)), slice()];
  /** A known text's characters at the cursor until `count` are written (each whole), no more than a made text holds. */
  const fill = (text: string, count: NumExpr): Stmt[] | null => {
    const cs = chars(text);
    if (!cs.length) return [];
    const j = fresh("j"), ph = fresh("ph"), times = fresh("times");
    const each = cs.map((ch) => writeConst(ch));
    if (each.some((x) => !x)) return null;
    let one: Stmt[] = each[cs.length - 1]!;
    for (let x = cs.length - 2; x >= 0; x--) one = [when(cmp("==", V(ph), k(x)), each[x]!, one)];
    return [
      dec(times, count), dec(j, k(0)), dec(ph, k(0)),
      loop(all(cmp("<", V(j), V(times)), cmp("<", V(CN), k(TEXT_BYTES), true)), [
        ...one,
        ...(cs.length > 1 ? [add(ph, 1), when(cmp("==", V(ph), k(cs.length)), [set(ph, k(0))])] : []),
        add(j, 1),
      ]),
    ];
  };

  /** What a text needs done before it is begun (`pre`), and what writes it at the cursor (`body`). */
  interface Writing { pre: Stmt[]; body: Stmt[] }
  /** A fresh made text with a block of its own, for a text made only to be read. */
  const temp = (): Made => {
    const id = fresh("made");
    return { e: `${id}@e`, n: `${id}@n`, c: `${id}@c`, block: `${id}@block` };
  };
  /** A text as a made one to read from: a made variable as it is, anything else made into a block of its own first. */
  const source = (t: TextExpr): { pre: Stmt[]; m: Made } | null => {
    if (t.kind === "textVar" && madeVars.has(t.id)) return { pre: [], m: madeVars.get(t.id)! };
    const m = temp();
    const body = make(t, m);
    return body ? { pre: [...blockOf(m), ...body], m } : null;
  };
  /** A text written at the cursor; null when it is of a kind this does not make yet. */
  const write = (t: TextExpr): Writing | null => {
    if (t.kind === "textVar" && madeVars.has(t.id)) return { pre: [], body: writeMade(madeVars.get(t.id)!) };
    if (t.kind === "textCall") {
      const r = call(t.call);
      return r?.result ? { pre: r.pre, body: writeMade(r.result) } : null;
    }
    const c = choice(t);
    if (c) {
      if (c.texts.length === 1) { const body = writeConst(c.texts[0]); return body ? { pre: [], body } : null; }
      // One of the texts it can be, by a test of its number.
      const pick = fresh("pick");
      const each = c.texts.map((text) => writeConst(text));
      if (each.some((x) => !x)) return null;
      let rest: Stmt[] = each[each.length - 1]!;
      for (let j = c.texts.length - 2; j >= 0; j--) rest = [when(cmp("==", V(pick), pool.id(c.texts[j])), each[j]!, rest)];
      return { pre: [dec(pick, c.expr)], body: rest };
    }
    switch (t.kind) {
      case "textTernary": {
        // (Each side's own needs not done before: they would be done whichever side is taken.)
        const a = write(t.whenTrue), b = write(t.whenFalse);
        return a && b && !a.pre.length && !b.pre.length ? { pre: [], body: [when(bool(t.cond), a.body, b.body)] } : null;
      }
      case "template": return writeParts(t.parts);
      case "textSlice": {
        const src = source(t.of);
        return src ? { pre: src.pre, body: writeSlice(src.m, t.start ? num(t.start) : k(0), t.end ? num(t.end) : undefined) } : null;
      }
      case "textPad": {
        // The text made first (its length is wanted), then the fill — a known text — before or after it.
        const by = choice(t.with);
        const src = by?.texts.length === 1 ? source(t.of) : null;
        if (!src) return null;
        const pad = fill(by!.texts[0], bin("-", num(t.width), V(src.m.c)));
        if (!pad) return null;
        const text = writeMade(src.m);
        return { pre: src.pre, body: t.side === "start" ? [...pad, ...text] : [...text, ...pad] };
      }
      case "textRepeat": {
        // A known text written whole each time; any other made first and copied.
        const one = choice(t.of);
        const times = fresh("times"), j = fresh("j");
        const again = (body: Stmt[]): Stmt[] => [dec(times, num(t.count)), dec(j, k(0)), loop(all(cmp("<", V(j), V(times)), cmp("<", V(CN), k(TEXT_BYTES), true)), [...body, add(j, 1)])];
        if (one?.texts.length === 1) {
          const w = writeConst(one.texts[0]);
          return w ? { pre: [], body: again(w) } : null;
        }
        const src = source(t.of);
        return src ? { pre: src.pre, body: again(writeMade(src.m)) } : null;
      }
      default: return null;
    }
  };
  const writeParts = (parts: TextPart[]): Writing | null => {
    const out: Writing = { pre: [], body: [] };
    for (const p of parts) {
      let part: Writing | null;
      if (p.kind === "text") { const body = writeConst(p.text); part = body ? { pre: [], body } : null; }
      else if (p.kind === "number") part = p.fixed ? null : { pre: [], body: [set(X, num(p.expr)), number(!!p.unsigned)] };
      else if (p.kind === "value") part = write(p.text);
      else if (p.kind === "char") part = { pre: [], body: [set(B, bin("+", num(p.expr), k(0))), when(cmp("!=", V(B), k(0)), [put(), add(CC, 1)])] };
      else part = null;
      if (!part) return null;
      out.pre.push(...part.pre);
      out.body.push(...part.body);
    }
    return out;
  };
  /** A text made into a made text's block from its start; null when it is of a kind this does not make yet. */
  const make = (t: TextExpr, into: Made): Stmt[] | null => {
    const w = write(t);
    return w ? [...w.pre, ...begin(V(into.e)), ...w.body, ...finish(into)] : null;
  };
  /**
   * The block of a made text (or the scratch one) and its numbers: laid out once, at the program's start (a block never
   * moves), its address kept in a cell read where it is used.
   */
  const blocks = new Map<string, Made>();
  const blockOf = (m: Made): Stmt[] => {
    blocks.set(m.block, m);
    return [];
  };
  /** Whether a text reads a variable. */
  const mentions = (x: unknown, id: string): boolean => {
    if (Array.isArray(x)) return x.some((y) => mentions(y, id));
    if (!x || typeof x !== "object") return false;
    const o = x as { kind?: string; id?: string };
    if (o.kind === "textVar" && o.id === id) return true;
    return Object.values(o).some((v) => v && typeof v === "object" && mentions(v, id));
  };
  /** One made text copied into another's block. */
  const copyBlock = (from: Made, into: Made): Stmt[] => [...begin(V(into.e)), ...writeMade(from), ...finish(into)];
  /** A made text equal to a known one (or not): its length, and each dword of the known one's bytes and 0 where it is. */
  const equalsKnown = (m: Made, text: string, op: CompareOp): BoolExpr => {
    // (After a made text's 0 its dword is 0s, as the known one's is here.)
    const b = [...enc.encode(text), 0];
    const items: BoolExpr[] = [cmp("==", V(m.n), k(b.length - 1))];
    for (let w = 0; 4 * w < b.length; w++) {
      const value = b.slice(4 * w, 4 * w + 4).reduce((n, x, j) => n + x * 2 ** (8 * j), 0);
      items.push({ kind: "cond", record: { location: 0, player: 0, amount: value, unitId: 0, comparison: 10, type: 15, resource: 0, flags: 0, mask: 0 }, epd: w ? bin("+", V(m.e), k(w)) : V(m.e) });
    }
    const both: BoolExpr = { kind: "and", items };
    return op === "==" ? both : { kind: "not", expr: both };
  };

  /**
   * The made text a `return` of the function or inlined call being rewritten makes its value into, and whether one
   * could not be made (the call is then refused whole: its result would be left empty without a word).
   */
  const results: { into?: Made; failed: boolean }[] = [];
  const recursive = new Set((program.functions ?? []).filter((f) => f.recursive).map((f) => f.id));
  /**
   * A call whose parameters or result are made texts: each such parameter made into its block before it (the call no
   * longer sets it), the call a statement whose `return`s make the result into its block. Null when one of them is not
   * a text this makes, or the function calls itself (its texts would need a block for each call).
   */
  const call = (c: Call): { pre: Stmt[]; result?: Made } | null => {
    if (c.fn && recursive.has(c.fn)) return null;
    const pre: Stmt[] = [];
    const params: Call["params"] = [];
    for (const p of c.params) {
      if (p.decl.kind !== "text") { params.push({ ...p, init: walk(p.init) as NumExpr }); continue; }
      const m = madeVars.get(p.decl.id);
      if (m) {
        const body = make(p.init as TextExpr, m);
        if (!body) return null;
        pre.push(...blockOf(m), ...body);
        continue;
      }
      const ch = idVars.has(p.decl.id) ? choice(p.init as TextExpr) : null;
      if (!ch) return null;
      pre.push({ kind: "declare", decl: { ...p.decl, kind: "number", text: undefined }, init: ch.expr, at: here, label: p.label });
    }
    const result = c.result?.kind === "text" ? madeVars.get(c.result.decl.id) : undefined;
    if (c.result?.kind === "text" && !result) return null;
    if (result) pre.push(...blockOf(result));
    results.push({ into: result, failed: false });
    const body = c.fn ? c.body : stmts(c.body);
    if (results.pop()!.failed) return null;
    const { result: _, ...rest } = c;
    void _;
    pre.push({ kind: "call", call: { ...rest, params, body, ...(result ? {} : c.result ? { result: c.result } : {}) }, at: c.at, label: c.label } as Stmt);
    return { pre, ...(result ? { result } : {}) };
  };

  // What is read of a made text — a character, a search, a test, an order — by the run time's functions, each called
  // with its operands in the run time's variables, its answer in `RV`.
  const IDX = G("idx"), FE = G("fe"), FN = G("fn"), FROM = G("from"), OFF = G("off");
  /**
   * The number of character `IDX` of the made text at `SE`, or −1 past either end. Of one byte a character, its byte
   * `IDX` read where it is; any other walked: each byte that starts a character counted, the one at `IDX` decoded
   * from it and the bytes after it.
   */
  const code = (): Stmt => fn("code", () => {
    const ci = G("ci3"), more = G("more"), we = G("we"), wo = G("wo");
    const and = (n: number): NumExpr => bin("&", V(R.b), k(n));
    return [
      set(RV, k(-1)),
      when(cmp("==", V(SC), V(SN)), [
        when(all(cmp(">=", V(IDX), k(0)), cmp("<", V(IDX), V(SN))), [set(we, bin("+", V(SE), bin(">>>", V(IDX), k(2)))), set(wo, bin("&", V(IDX), k(3))), readByte(RV, we, wo)]),
      ], [
        ...reader(R, { e: V(SE) }), set(ci, k(-1)), set(more, k(-1)),
        loop(all(cmp("<", V(R.i), V(SN), true), cmp("!=", V(more), k(0))), [
          ...next(R),
          when(starts(R.b), [
            add(ci, 1),
            when(cmp("==", V(ci), V(IDX)), [
              when(cmp("<", V(R.b), k(0x80), true), [set(RV, V(R.b)), set(more, k(0))], [
                when(cmp(">=", V(R.b), k(0xf0), true), [set(RV, and(7)), set(more, k(3))], [
                  when(cmp(">=", V(R.b), k(0xe0), true), [set(RV, and(15)), set(more, k(2))], [set(RV, and(31)), set(more, k(1))]),
                ]),
              ]),
            ]),
          ], [when(cmp(">=", V(more), k(1)), [set(RV, bin("+", bin("*", V(RV), k(64)), and(63))), add(more, -1)])]),
        ]),
      ]),
    ];
  });
  /**
   * Whether the `FN` bytes of the made text at `FE` are at byte `OFF` of the one at `SE` (1 or 0): the two read side
   * by side until it ends or a byte differs.
   */
  const T: Reader = { se: G("te"), so: G("to"), i: G("ti"), b: G("tb") }, F: Reader = { se: G("fe2"), so: G("fo"), i: G("fi"), b: G("fb") };
  const prefix = (): Stmt => fn("prefix", () => [
    set(T.se, bin("+", V(SE), bin(">>>", V(OFF), k(2)))), set(T.so, bin("&", V(OFF), k(3))), set(T.i, k(0)),
    ...reader(F, { e: V(FE) }), set(RV, k(1)),
    loop(all(cmp("<", V(F.i), V(FN), true), cmp("==", V(RV), k(1))), [...next(F), ...next(T), when(cmp("!=", V(T.b), V(F.b)), [set(RV, k(0))])]),
  ]);
  /**
   * The place in characters of the first match of the made text at `FE` in the one at `SE`, at or after character
   * `FROM`, or −1: at each byte that starts a character from there, `prefix` asked.
   */
  const find = (): Stmt => fn("find", () => {
    const ci = G("ci4"), at = G("at4"), found = G("found");
    return [
      set(FROM, { kind: "intrinsic", name: "max", args: [V(FROM), k(0)], at: here, label: "" } as NumExpr), set(found, k(-1)),
      when(cmp("==", V(FN), k(0)), [when(cmp("<=", V(FROM), V(SC)), [set(found, V(FROM))])], [
        ...reader(R, { e: V(SE) }), set(ci, k(0)),
        loop(all(cmp("<", V(R.i), V(SN), true), cmp("<", V(found), k(0))), [
          set(at, V(R.i)),
          readByte(R.b, R.se, R.so),
          when(all(cmp(">=", V(ci), V(FROM)), starts(R.b)), [set(OFF, V(at)), prefix(), when(cmp("==", V(RV), k(1)), [set(found, V(ci))])]),
          ...next(R),
          when(starts(R.b), [add(ci, 1)]),
        ]),
      ]),
      set(RV, V(found)),
    ];
  });
  /** The made texts at `SE` and `FE` compared byte by byte (UTF-8's order of bytes is its characters'): below 0, 0, above. */
  const order = (): Stmt => fn("order", () => [
    ...reader(R, { e: V(SE) }), ...reader(F, { e: V(FE) }), set(RV, k(0)),
    loop(cmp("==", V(RV), k(0)), [
      ...next(R), ...next(F),
      when(cmp("!=", V(R.b), V(F.b)), [set(RV, bin("-", V(R.b), V(F.b)))], [when(cmp("==", V(R.b), k(0)), [{ kind: "break", at: here, label: "" } as Stmt])]),
    ]),
  ]);
  const operands = (m: Made): Stmt[] => [set(SE, V(m.e)), set(SN, V(m.n)), set(SC, V(m.c))];
  const needle = (m: Made): Stmt[] => [set(FE, V(m.e)), set(FN, V(m.n))];
  /**
   * A number or a test of texts that are not all known when built, worked out by statements before the statement it is
   * in: its value then a variable. Null when it is not one of those, or one of its texts is not made by this.
   */
  const measured = (o: { kind?: string }, pre: Stmt[]): NumExpr | BoolExpr | null => {
    const out = fresh("v");
    const take = (t: TextExpr) => {
      if (choice(t)) return null;
      const src = source(t);
      if (src) pre.push(...src.pre);
      return src?.m ?? null;
    };
    /** A text read from that may be known: made into a block when it is not a made variable. */
    const any = (t: TextExpr) => { const src = source(t); if (src) pre.push(...src.pre); return src?.m ?? null; };
    const answer = (stmts: Stmt[]): NumExpr => { pre.push(...stmts, dec(out, V(RV))); return V(out); };
    switch (o.kind) {
      case "textLength": { const m = take((o as Extract<NumExpr, { kind: "textLength" }>).of); return m ? V(m.c) : null; }
      case "textCode": {
        const e = o as Extract<NumExpr, { kind: "textCode" }>, m = take(e.of);
        return m ? answer([...operands(m), set(IDX, num(e.index)), code()]) : null;
      }
      case "textIndexOf": {
        const e = o as Extract<NumExpr, { kind: "textIndexOf" }>, m = take(e.of), f = m ? any(e.find) : null;
        return m && f ? answer([...operands(m), ...needle(f), set(FROM, e.from ? num(e.from) : k(0)), find()]) : null;
      }
      case "textTest": {
        const e = o as Extract<BoolExpr, { kind: "textTest" }>, m = take(e.of), f = m ? any(e.find) : null;
        if (!m || !f) return null;
        if (e.test === "includes") return cmp(">=", answer([...operands(m), ...needle(f), set(FROM, k(0)), find()]), k(0));
        // (Where it would start: 0, or the text's length less the other's, in bytes; nothing when it is longer.)
        const off = e.test === "startsWith" ? k(0) : bin("-", V(m.n), V(f.n));
        pre.push(dec(out, k(0)), when(cmp(">=", V(m.n), V(f.n), true), [...operands(m), ...needle(f), set(OFF, off), prefix(), set(out, V(RV))]));
        return cmp("==", V(out), k(1));
      }
      case "textCompare": {
        const e = o as Extract<BoolExpr, { kind: "textCompare" }>;
        if (choice(e.left) && choice(e.right)) return null;
        // (A made variable the same as a known text, or not: one condition a dword, `equalsKnown`.)
        const known = (t: TextExpr) => { const c = choice(t); return c?.texts.length === 1 ? c.texts[0] : undefined; };
        const mv = (t: TextExpr) => t.kind === "textVar" && madeVars.has(t.id);
        if ((e.op === "==" || e.op === "!=") && ((mv(e.left) && known(e.right) !== undefined) || (mv(e.right) && known(e.left) !== undefined))) return null;
        const a = any(e.left), b = a ? any(e.right) : null;
        if (!a || !b) return null;
        return cmp(e.op, answer([set(SE, V(a.e)), set(FE, V(b.e)), order()]), k(0));
      }
      default: return null;
    }
  };

  /**
   * A statement's texts that are only made to be looked at — a call's result, a text compared or measured — made first,
   * each into a block of its own, and looked at there.
   */
  const hoist = (x: unknown, pre: Stmt[]): unknown => {
    if (Array.isArray(x)) return x.map((y) => hoist(y, pre));
    if (!x || typeof x !== "object") return x;
    const o = x as { kind?: string };
    if (o.kind === "textLength" || o.kind === "textCode" || o.kind === "textIndexOf" || o.kind === "textTest" || o.kind === "textCompare") {
      // (A made variable's length, and a made text against a known one, need no statements: `num`, `bool`.)
      const easy = o.kind === "textLength" ? (o as { of: TextExpr }).of.kind === "textVar" && madeVars.has(((o as { of: TextExpr }).of as { id: string }).id) : false;
      const v = easy ? null : measured(o, pre);
      if (v) return v;
    }
    if (o.kind === "textCall") {
      const r = call((o as Extract<TextExpr, { kind: "textCall" }>).call);
      if (!r?.result) return o;
      pre.push(...r.pre);
      return { kind: "textVar", id: [...madeVars].find(([, m]) => m === r.result)![0] };
    }
    // (A call of a number or a condition with texts among its parameters: a statement first, its result read after.)
    const c = (o as { call?: Call }).call;
    if (o.kind === "call" && c?.params.some((p) => p.decl.kind === "text") && c.result && c.result.kind !== "text") {
      const r = call(c);
      if (!r) return o;
      pre.push(...r.pre);
      return { kind: "var", id: c.result.decl.id };
    }
    // (Statement lists — a call's body among them — are not looked into: their statements are rewritten as theirs.)
    const out: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(o)) out[key] = v && typeof v === "object" && key !== "body" && key !== "then" && key !== "else" ? hoist(v, pre) : v;
    return out;
  };

  const stmts = (body: Stmt[]): Stmt[] => body.flatMap((s) => {
    // (A text call where a text is only looked at: made first. In a `while`'s test, which is asked again and again, the
    // loop asks it at the top of its body: `while (true) { …; if (!test) break; … }`.)
    if (s.kind === "while") {
      if ("at" in s && s.at) here = s.at;
      const pre: Stmt[] = [];
      const cond = hoist(s.cond, pre) as BoolExpr;
      if (!pre.length) return stmt(s);
      return [{ ...s, cond: { kind: "const", value: true }, body: [...pre, when({ kind: "not", expr: bool(cond) }, [{ kind: "break", at: here, label: "" } as Stmt]), ...stmts(s.body)] }];
    }
    if (s.kind === "do" || s.kind === "for") return stmt(s);
    const pre: Stmt[] = [];
    const t = { ...s, ...Object.fromEntries(Object.entries(s).filter(([key]) => key !== "then" && key !== "else" && key !== "body").map(([key, v]) => [key, v && typeof v === "object" ? hoist(v, pre) : v])) } as Stmt;
    return [...pre, ...stmt(t)];
  });
  const stmt = (s: Stmt): Stmt[] => {
    if ("at" in s && s.at) here = s.at;
    switch (s.kind) {
      case "return": {
        const top = results[results.length - 1];
        if (!top?.into || !s.value || !isTextExpr(s.value as { kind: string })) break;
        const body = make(s.value as TextExpr, top.into);
        if (!body) { top.failed = true; return [walk(s) as Stmt]; }
        return [...body, { kind: "return", at: s.at, label: s.label }];
      }
      case "declare": {
        if (s.decl.temp && s.decl.kind === "number" && readsOf(s.init as NumExpr)) temps.set(s.decl.id, s.init as NumExpr);
        if (madeVars.has(s.decl.id)) {
          const m = madeVars.get(s.decl.id)!;
          const body = make(s.init as TextExpr, m);
          return body ? [...blockOf(m), ...body] : [walk(s) as Stmt];
        }
        if (s.decl.kind !== "text" || !idVars.has(s.decl.id)) break;
        const c = choice(s.init as TextExpr);
        if (!c) break;
        return [{ ...s, decl: { ...s.decl, kind: "number", text: undefined }, init: c.expr }];
      }
      case "assignText": {
        if (madeVars.has(s.target)) {
          // Into its own block, unless the text reads the variable: then made in the scratch block and copied over.
          const m = madeVars.get(s.target)!;
          if (!mentions(s.value, s.target)) return make(s.value, m) ?? [walk(s) as Stmt];
          const body = make(s.value, SCRATCH);
          return body ? [...blockOf(SCRATCH), ...body, ...copyBlock(SCRATCH, m)] : [walk(s) as Stmt];
        }
        if (!idVars.has(s.target)) break;
        const c = choice(s.value);
        if (!c) break;
        return [{ kind: "assign", target: s.target, value: c.expr, at: s.at, label: s.label }];
      }
      case "print": return print(s);
      case "call": {
        if (!s.call.params.some((p) => p.decl.kind === "text") && s.call.result?.kind !== "text") break;
        const r = call(s.call);
        return r ? r.pre : [walk(s) as Stmt];
      }
      case "textLoop": {
        // Each character made into the loop's variable — the byte that starts it and those after it — then the body.
        // (The walk's own reader: the body may read texts with the run time's.)
        const m = madeVars.get(s.decl.id), src = m ? source(s.of) : null;
        if (!m || !src) break;
        const r: Reader = { se: fresh("se"), so: fresh("so"), i: fresh("i"), b: fresh("b") }, look = fresh("look");
        return [
          ...src.pre, ...blockOf(m), dec(r.se, V(src.m.e)), dec(r.so, k(0)), dec(r.i, k(0)), dec(r.b, k(0)), dec(look, k(0)),
          loop(cmp("<", V(r.i), V(src.m.n), true), [
            ...begin(V(m.e)),
            ...next(r), set(B, V(r.b)), put(), add(CC, 1),
            readByte(look, r.se, r.so),
            loop(all(cmp("<", V(r.i), V(src.m.n), true), { kind: "not", expr: starts(look) }), [...next(r), set(B, V(r.b)), put(), readByte(look, r.se, r.so)]),
            ...finish(m),
            ...stmts(s.body),
          ]),
        ];
      }
      case "action": {
        if (!s.text) break;
        const c = choice(s.text);
        if (!c || c.texts.length === 1) break;
        // The text field from the value: the string its number names. (The rest rewritten first: the choice's numbers
        // are the pool's to fill in, and a copy of them would not be.)
        const { text: _, ...rest } = s;
        void _;
        const done = walk(rest) as Extract<Stmt, { kind: "action" }>;
        return [{ ...done, variables: [...(done.variables ?? []), { field: "text", bits: 32, name: "text", expr: { kind: "binary", op: "+", left: c.expr, right: k(base), at: s.at, label: s.label } }] }];
      }
    }
    return [walk(s) as Stmt];
  };

  /**
   * A print with texts known when built in it. One of them alone: Display Text of the string its number names (to the
   * current player). Otherwise printed once for each text each can be, under a test of which it is — each choice
   * worked out once, into a variable of its own.
   */
  const print = (s: Extract<Stmt, { kind: "print" }>): Stmt[] => {
    const parts = s.parts.map((p) => (p.kind === "value" ? choice(p.text) : null));
    if (s.parts.some((p, i) => p.kind === "value" && !parts[i]) && s.position === "chat") {
      // A made text in it. Alone: its block shown as it is. Else the printed text made in the scratch block, shown.
      const [first] = s.parts;
      if (s.parts.length === 1 && first.kind === "value" && first.text.kind === "textVar" && madeVars.has(first.text.id)) return [{ kind: "showText", block: madeVars.get(first.text.id)!.block, bytes: BLOCK, to: s.to, at: s.at }];
      const body = make({ kind: "template", parts: s.parts, at: s.at, label: s.label }, SCRATCH);
      if (!body) return [walk(s) as Stmt];
      return [...blockOf(SCRATCH), ...body, { kind: "showText", block: SCRATCH.block, bytes: BLOCK, to: s.to, at: s.at }];
    }
    if (!parts.some((c) => c && c.texts.length > 1)) {
      const plain = s.parts.map((p, i) => (parts[i] ? ({ kind: "text", text: parts[i]!.texts[0] } as TextPart) : p));
      return [walk({ ...s, parts: plain }) as Stmt];
    }
    if (s.parts.some((p, i) => p.kind === "value" && !parts[i])) return [walk(s) as Stmt];
    const choices = parts.filter((c): c is Choice => !!c && c.texts.length > 1);
    if (choices.reduce((m, c) => m * c.texts.length, 1) > MOST_PRINTS) return bytes(s, parts);
    const one = s.parts.length === 1 && s.position === "chat" && s.to === CURRENT_PLAYER && !choices[0].texts.includes("");
    if (one) {
      const record = { location: 0, text: 0, wav: 0, time: 0, player: 0, target: 0, unitId: 0, type: DISPLAY_TEXT, modifier: 0, flags: 4, padding: 0, mask: 0 };
      return [{ kind: "action", record, variables: [{ field: "text", bits: 32, name: "text", expr: { kind: "binary", op: "+", left: choices[0].expr, right: k(base), at: s.at, label: s.label } }], at: s.at, label: s.label }];
    }
    const out: Stmt[] = [];
    const picks = choices.map((c) => {
      const decl: VarDecl = { id: fresh("pick"), name: "(text)", kind: "number", shared: false, at: s.at };
      out.push({ kind: "declare", decl, init: c.expr, at: s.at, label: s.label });
      return { c, id: decl.id };
    });
    // Each text of the first choice, under a test of it; inside, each of the next's; the print at the bottom.
    const nest = (i: number, chosen: Map<Choice, string>): Stmt[] => {
      if (i === picks.length) {
        const plain = s.parts.map((p, j) => (parts[j] ? ({ kind: "text", text: chosen.get(parts[j]!) ?? parts[j]!.texts[0] } as TextPart) : p));
        return [walk({ ...s, parts: plain }) as Stmt];
      }
      const { c, id } = picks[i];
      let rest: Stmt[] = nest(i + 1, new Map([...chosen, [c, c.texts[c.texts.length - 1]]]));
      for (let j = c.texts.length - 2; j >= 0; j--) {
        rest = [{ kind: "if", cond: { kind: "compare", op: "==", left: { kind: "var", id }, right: pool.id(c.texts[j]), at: s.at, label: s.label }, then: nest(i + 1, new Map([...chosen, [c, c.texts[j]]])), else: rest, at: s.at, label: s.label }];
      }
      return rest;
    };
    out.push(...nest(0, new Map()));
    return out;
  };

  /**
   * A print with texts of many choices in it: each of them a field of the printed text, which the text it is is
   * written into whole (a `pick`: a case for each text, by its number; or by its place in the table it is read from).
   * What it is picked by is worked out once, into a variable of its own.
   */
  const bytes = (s: Extract<Stmt, { kind: "print" }>, parts: (Choice | null)[]): Stmt[] => {
    const out: Stmt[] = [];
    const once = (e: NumExpr): NumExpr => {
      if (e.kind === "var" || e.kind === "const") return e;
      const decl: VarDecl = { id: fresh("at"), name: "(text)", kind: "number", shared: false, at: s.at };
      out.push({ kind: "declare", decl, init: e, at: s.at, label: s.label });
      return { kind: "var", id: decl.id };
    };
    const printed: TextPart[] = [];
    for (const [i, p] of s.parts.entries()) {
      const c = parts[i];
      if (!c || c.texts.length === 1) { printed.push(c ? { kind: "text", text: c.texts[0] } : (walk(p) as TextPart)); continue; }
      if (c.over) {
        // (Places next to each other with the same text, one case from the first to the last.)
        const cases: { when: NumExpr; upTo?: NumExpr; text: string }[] = [];
        c.over.results.forEach((text, j) => {
          const last = cases[cases.length - 1];
          if (last && last.text === text) last.upTo = k(j);
          else cases.push({ when: k(j), text });
        });
        printed.push({ kind: "pick", by: once(c.over.index), cases });
      }
      else printed.push({ kind: "pick", by: once(c.expr), cases: c.texts.map((text) => ({ when: pool.id(text), text })) });
    }
    out.push({ ...(walk({ ...s, parts: [] }) as Extract<Stmt, { kind: "print" }>), parts: printed });
    return out;
  };

  const body = stmts(program.body);
  // (A called function that gives back a made text makes it into its result's block, and has no result of its own.)
  const functions = program.functions?.map((f) => {
    const result = f.result?.kind === "text" && !recursive.has(f.id) ? madeVars.get(f.result.decl.id) : undefined;
    results.push({ into: result, failed: false });
    const fbody = stmts(f.body);
    // (One of its texts not made: the function as it was, for the emitter to refuse.)
    if (results.pop()!.failed) return f;
    return { ...f, body: fbody, ...(result ? { result: undefined } : {}) };
  });
  // The run time's variables declared at the program's start, its functions beside the program's.
  here = program.at;
  // (The shared ones kept in one cell each — the cursor, the reader, the operands — and so each block's address.)
  const ROUTED = new Set([CE, CO, CN, CC, B, SE, SN, SC, RV, X, BLK, IDX, FE, FN, FROM, OFF, LO, HI, R.se, R.so, R.i, R.b, T.se, T.so, T.i, T.b, F.se, F.so, F.i, F.b]);
  const start: Stmt[] = [
    ...[...globals].map((id) => dec(id, k(0), ROUTED.has(id))),
    ...[...known].map(([text, id]) => ({ kind: "textBlock", decl: { id: `${id}@e`, name: "(text)", kind: "number", shared: false, at: here, routed: true }, block: id, bytes: enc.encode(text).length + 1, text, at: here }) as Stmt),
    ...[...blocks.values()].flatMap((m) => [
      { kind: "textBlock", decl: { id: m.e, name: "(text)", kind: "number", shared: false, at: here, routed: true }, block: m.block, bytes: BLOCK, at: here } as Stmt,
      dec(m.n, k(0)),
      dec(m.c, k(0)),
    ]),
  ];
  const fns = [...runtime.values()].filter((f): f is FuncDecl => !!f);
  return { ...program, body: [...start, ...body], ...(functions || fns.length ? { functions: [...(functions ?? []), ...fns] } : {}), arrays };
}

const CURRENT_PLAYER = 13;
/** The most a made text holds, in bytes (`compiler/ir.ts` has the same). */
const TEXT_BYTES = 1023;
const DISPLAY_TEXT = 9;
// (`call` and `pop` are numbers too: a list of numbers that starts with one is walked as statements, which does to
// each what walking it as a number would.)
const STMT_KINDS = new Set(["action", "assign", "assignBool", "assignText", "assignUnit", "block", "break", "buildText", "call", "cancel", "centerLocation", "continue", "declare", "declareArray", "do", "for", "graph", "if", "parallel", "pop", "print", "push", "releaseText", "remark", "return", "select", "setLength", "sleep", "start", "store", "storeText", "switch", "syncSend", "tableWrite", "textLoop", "throw", "try", "uncaught", "unitDo", "unitLoop", "unitWrite", "unrolled", "while"]);
function isStmt(o: unknown): boolean {
  return !!o && typeof o === "object" && STMT_KINDS.has((o as { kind?: string }).kind ?? "");
}
