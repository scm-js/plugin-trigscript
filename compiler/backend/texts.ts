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
import { programDeclarations, type ArrayDecl, type At, type BoolExpr, type CompareOp, type NumExpr, type Program, type Stmt, type TextExpr, type TextPart, type VarDecl } from "../ir";

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
  const decls = new Map(programDeclarations(program).map((d) => [d.id, d]));
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
    const span = 2 * Math.max(...texts.map((s) => chars(s).length)) + 8;
    let lo = -span, hi = span;
    // (It must not change past either end: a number the variable is multiplied by is not taken.)
    if (at_(lo) !== at_(lo - 1000) || at_(hi) !== at_(hi + 1000)) return null;
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

  const stmts = (body: Stmt[]): Stmt[] => body.flatMap(stmt);
  const stmt = (s: Stmt): Stmt[] => {
    switch (s.kind) {
      case "declare": {
        if (s.decl.temp && s.decl.kind === "number" && readsOf(s.init as NumExpr)) temps.set(s.decl.id, s.init as NumExpr);
        if (s.decl.kind !== "text" || !idVars.has(s.decl.id)) break;
        const c = choice(s.init as TextExpr);
        if (!c) break;
        return [{ ...s, decl: { ...s.decl, kind: "number", text: undefined }, init: c.expr }];
      }
      case "assignText": {
        if (!idVars.has(s.target)) break;
        const c = choice(s.value);
        if (!c) break;
        return [{ kind: "assign", target: s.target, value: c.expr, at: s.at, label: s.label }];
      }
      case "print": return print(s);
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
  const functions = program.functions?.map((f) => ({ ...f, body: stmts(f.body) }));
  return { ...program, body, ...(functions ? { functions } : {}), arrays };
}

const CURRENT_PLAYER = 13;
const DISPLAY_TEXT = 9;
// (`call` and `pop` are numbers too: a list of numbers that starts with one is walked as statements, which does to
// each what walking it as a number would.)
const STMT_KINDS = new Set(["action", "assign", "assignBool", "assignText", "assignUnit", "block", "break", "buildText", "call", "cancel", "centerLocation", "continue", "declare", "declareArray", "do", "for", "graph", "if", "parallel", "pop", "print", "push", "releaseText", "remark", "return", "select", "setLength", "sleep", "start", "store", "storeText", "switch", "syncSend", "tableWrite", "textLoop", "throw", "try", "uncaught", "unitDo", "unitLoop", "unitWrite", "unrolled", "while"]);
function isStmt(o: unknown): boolean {
  return !!o && typeof o === "object" && STMT_KINDS.has((o as { kind?: string }).kind ?? "");
}
