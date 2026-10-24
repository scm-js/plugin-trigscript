/**
 * Whole programs made at random (TrigScript 4, step 16 of the way off eudplib: the gate before the Python goes; the
 * plan's idea 17, "as Csmith does C"). A script is drawn as a small tree — the program's variables, its functions,
 * statements and expressions of the language's core: numbers with every operator, booleans, texts known and made,
 * arrays fixed and growing, a record, `if`, `for`, `while`, `do`, `switch`, `break` and `continue`, calls and a
 * function that calls itself, `try`, `throw` and `finally`, the deaths table and switches, `sleep` — and rendered
 * twice from the one tree: as TrigScript, for the compiler, the simulator, the build and the game; and as JavaScript,
 * whose own arithmetic (32 bits, `Math.imul`, a quotient cut towards zero) says what the lines must be. Every loop
 * carries a guard, every index stays inside its array, and a `throw` stands inside a `try`, so the program always
 * ends and never faults: what the four runs print, frame by frame, is what is compared.
 *
 * `reduce` cuts a program that fails down to the smallest that still does, a statement at a time.
 */

export interface Rng { next(): number; int(n: number): number; pick<T>(xs: readonly T[]): T; chance(p: number): boolean }

/** mulberry32: the same seed, the same program, on every machine. */
export function rng(seed: number): Rng {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return { next, int: (n) => Math.floor(next() * n), pick: (xs) => xs[Math.floor(next() * xs.length)], chance: (p) => next() < p };
}

// ── the tree ──

export type NExpr =
  | { k: "const"; v: number }
  | { k: "var"; name: string }
  | { k: "bin"; op: "+" | "-" | "*" | "/" | "%" | "&" | "|" | "^" | "<<" | ">>"; l: NExpr; r: NExpr }
  | { k: "neg"; e: NExpr }
  | { k: "tern"; c: BExpr; t: NExpr; f: NExpr }
  | { k: "el"; arr: string; idx: NExpr; mask: number }
  | { k: "gel"; arr: string; idx: NExpr }
  | { k: "len"; arr: string }
  | { k: "tlen"; text: TExpr }
  | { k: "call"; fn: string; args: Arg[] }
  | { k: "math"; fn: "abs" | "min" | "max"; args: NExpr[] }
  | { k: "pop"; arr: string }
  | { k: "deaths"; unit: string }
  | { k: "field"; rec: string; field: string };
export type BExpr =
  | { k: "bconst"; v: boolean }
  | { k: "bvar"; name: string }
  | { k: "cmp"; op: "<" | "<=" | ">" | ">=" | "==" | "!="; l: NExpr; r: NExpr }
  | { k: "and"; items: BExpr[] }
  | { k: "or"; items: BExpr[] }
  | { k: "not"; e: BExpr }
  | { k: "tcmp"; op: "===" | "!=="; l: TExpr; r: TExpr }
  | { k: "bcall"; fn: string; args: Arg[] }
  | { k: "switchIs"; n: number };
export type TExpr =
  | { k: "tlit"; s: string }
  | { k: "tvar"; name: string }
  | { k: "tmpl"; parts: (string | NExpr | TExpr)[] }
  | { k: "ttern"; c: BExpr; t: TExpr; f: TExpr };
export type Arg = NExpr | BExpr;

export type Stmt =
  | { k: "assign"; name: string; op: "=" | "+=" | "-="; e: NExpr }
  | { k: "bassign"; name: string; e: BExpr }
  | { k: "tassign"; name: string; e: TExpr }
  | { k: "fassign"; rec: string; field: string; op: "=" | "+="; e: NExpr }
  | { k: "if"; c: BExpr; then: Stmt[]; else?: Stmt[] }
  | { k: "for"; i: string; bound: NExpr; body: Stmt[] }
  | { k: "while"; c: BExpr; guard: string; body: Stmt[] }
  | { k: "do"; body: Stmt[]; c: BExpr; guard: string }
  | { k: "switch"; e: NExpr; cases: { v: number; body: Stmt[] }[]; def: Stmt[] }
  | { k: "break" }
  | { k: "continue" }
  | { k: "store"; arr: string; idx: NExpr; mask: number; e: NExpr }
  | { k: "gstore"; arr: string; idx: NExpr; e: NExpr }
  | { k: "push"; arr: string; e: NExpr }
  | { k: "callstmt"; fn: string; args: Arg[] }
  | { k: "try"; body: Stmt[]; catch: Stmt[]; finally?: Stmt[] }
  | { k: "throw"; what: string }
  | { k: "print"; parts: (string | NExpr | TExpr)[] }
  | { k: "sleep"; n: number }
  | { k: "setDeaths"; unit: string; mod: "add" | "set" | "subtract"; e: NExpr }
  | { k: "setSwitch"; n: number; to: "set" | "clear" | "toggle" }
  | { k: "return"; e?: Arg };

export interface Param { name: string; kind: "number" | "boolean" }
export interface Func { name: string; params: Param[]; locals: string[]; returns: "number" | "boolean" | "void"; body: Stmt[]; recursive: boolean }
export interface Decl { name: string; kind: "number" | "boolean" | "text" | "fixed" | "growing" | "record" | "read"; init: number | boolean | string | number[] }
export interface ProgramTree { decls: Decl[]; functions: Func[]; body: Stmt[] }
export interface Generated { seed: number; programs: ProgramTree[]; frames: number }

const UNITS = ["TerranMarine", "ZergZergling", "ProtossZealot"];
const WORDS = ["ab", "Marine", "x", "zzz", "Mf", "k9"];
const EDGES = [0, 1, 2, 3, 7, -1, -2, 255, 256, 1023, 65535, 65536, 2147483647, -2147483648, 1000000, -77];
const THROWS = ["Error", "RangeError", "TypeError"];

interface Scope {
  nums: string[]; bools: string[]; texts: string[]; fixed: { name: string; mask: number }[]; growing: string[]; records: string[];
  /** The functions a body may call: those made before it. */
  calls: Func[];
  /** Numbers read but never assigned: the counters of `for` loops. */
  ro: string[];
  /** Inside a loop (break/continue allowed), inside a try (throw allowed), at the program's top (sleep allowed). */
  loop: boolean; tried: boolean; top: boolean;
  /** Inside a `finally`: no `return` leaves it. */
  finally?: boolean;
  fn?: Func;
}

/** One program of the seed: `label` tells its lines apart from the other programs' of a batch. */
export function randomProgram(r: Rng, label: string): ProgramTree {
  let names = 0;
  const fresh = (p: string) => `${p}${names++}`;
  const decls: Decl[] = [];
  const scope: Scope = { nums: [], bools: [], texts: [], fixed: [], growing: [], records: [], calls: [], ro: [], loop: false, tried: false, top: true };
  const guard = () => { const g = fresh("g"); decls.push({ name: g, kind: "number", init: 0 }); return g; };
  let prints = 0;

  // (z: a number the compiler cannot see — the deaths of a unit nothing of the script sets — for the divisors, 0 in the game.)
  decls.push({ name: "z", kind: "read", init: 0 });
  scope.ro.push("z");
  for (let i = 0, n = 2 + r.int(4); i < n; i++) { const d = fresh("n"); decls.push({ name: d, kind: "number", init: r.pick(EDGES) }); scope.nums.push(d); }
  for (let i = 0, n = r.int(3); i < n; i++) { const d = fresh("b"); decls.push({ name: d, kind: "boolean", init: r.chance(0.5) }); scope.bools.push(d); }
  for (let i = 0, n = r.int(3); i < n; i++) { const d = fresh("t"); decls.push({ name: d, kind: "text", init: r.pick(WORDS) }); scope.texts.push(d); }
  for (let i = 0, n = r.int(3); i < n; i++) { const d = fresh("xs"); const len = r.pick([2, 4, 8]); decls.push({ name: d, kind: "fixed", init: Array.from({ length: len }, () => r.pick(EDGES)) }); scope.fixed.push({ name: d, mask: len - 1 }); }
  for (let i = 0, n = r.int(3); i < n; i++) { const d = fresh("ys"); decls.push({ name: d, kind: "growing", init: r.chance(0.5) ? [] : [r.pick(EDGES), r.pick(EDGES)] }); scope.growing.push(d); }
  for (let i = 0, n = r.int(2); i < n; i++) { const d = fresh("p"); decls.push({ name: d, kind: "record", init: [r.pick(EDGES), r.pick(EDGES)] }); scope.records.push(d); }

  const num = (s: Scope, depth: number): NExpr => {
    const leaf = depth <= 0 || r.chance(0.3);
    const leaves: (() => NExpr)[] = [() => ({ k: "const", v: r.chance(0.5) ? r.pick(EDGES) : r.int(40) - 10 })];
    const locals = s.fn ? [...s.fn.params.filter((p) => p.kind === "number").map((p) => p.name), ...s.fn.locals] : [];
    const readable = [...s.nums, ...s.ro, ...locals];
    if (readable.length) leaves.push(() => ({ k: "var", name: r.pick(readable) }), () => ({ k: "var", name: r.pick(readable) }));
    if (s.fixed.length) leaves.push(() => { const a = r.pick(s.fixed); return { k: "el", arr: a.name, idx: num(s, depth - 1), mask: a.mask }; });
    if (s.growing.length) leaves.push(() => ({ k: "len", arr: r.pick(s.growing) }), () => ({ k: "gel", arr: r.pick(s.growing), idx: num(pure(s), depth - 1) }));
    if (s.records.length) leaves.push(() => ({ k: "field", rec: r.pick(s.records), field: r.pick(["x", "y"]) }));
    if (s.texts.length && r.chance(0.3)) leaves.push(() => ({ k: "tlen", text: text(s, 0) }));
    if (r.chance(0.1)) leaves.push(() => ({ k: "deaths", unit: r.pick(UNITS) }));
    if (leaf) return r.pick(leaves)();
    const inner: (() => NExpr)[] = [
      () => {
        const op = r.pick(["+", "+", "-", "*", "/", "%", "&", "|", "^", "<<", ">>"] as const);
        let l = num(s, depth - 1), right = num(s, depth - 1);
        // (A divisor the compiler can see is 0 — a constant, a variable never assigned, a cell of an array as declared — is
        // a compile error, as the language has it: those are made odd. One worked out in the game may still be 0.)
        if (op === "/" || op === "%") right = r.chance(0.3) ? { k: "var", name: "z" } : { k: "bin", op: "|", l: right, r: { k: "const", v: 1 } };
        if (constLike(l) && constLike(right)) l = unconst(s, l);
        return { k: "bin", op, l, r: right };
      },
      () => { const e = num(s, depth - 1); return constLike(e) ? { k: "const", v: Math.min(2147483647, Math.max(-2147483647, -constValue(e))) } : { k: "neg", e }; },
      () => ({ k: "tern", c: bool(s, depth - 1, true), t: num(s, depth - 1), f: num(s, depth - 1) }),
      () => { const fn = r.pick(["abs", "min", "max"] as const); const a = num(s, depth - 1); return { k: "math", fn, args: fn === "abs" ? [constLike(a) ? unconst(s, a) : a] : [a, num(s, depth - 1)] }; },
    ];
    const numFns = s.calls.filter((f) => f.returns === "number");
    if (numFns.length) inner.push(() => call(s, r.pick(numFns), depth - 1) as NExpr);
    if (s.growing.length && r.chance(0.3)) inner.push(() => ({ k: "pop", arr: r.pick(s.growing) }));
    return r.pick(inner)();
  };
  const call = (s: Scope, f: Func, depth: number): NExpr | BExpr => {
    const args: Arg[] = f.params.map((p) => (p.kind === "number" ? (f.recursive ? (s.fn === f ? { k: "bin", op: "-", l: { k: "var", name: p.name }, r: { k: "const", v: 1 + r.int(2) } } : { k: "const", v: r.int(5) }) : num(s, depth)) : bool(s, depth)));
    return f.returns === "boolean" ? { k: "bcall", fn: f.name, args } : { k: "call", fn: f.name, args };
  };
  /** The scope with nothing in it that changes an array that grows: no pop, no call (an index, and a value stored beside one). */
  const pure = (s: Scope): Scope => ({ ...s, growing: [], calls: [] });
  /** A constant, or the negative of one: TypeScript gives it a literal type, and the compiler works it out when the script is built. */
  const constLike = (e: NExpr): boolean => e.k === "const" || (e.k === "neg" && constLike(e.e));
  const constValue = (e: NExpr): number => (e.k === "const" ? e.v : e.k === "neg" ? -constValue(e.e) : 0);
  /** A side that is not a constant where one is wanted: a variable of the scope, else the constant itself. */
  const unconst = (s: Scope, e: NExpr): NExpr => {
    const names = [...s.nums, ...s.ro, ...(s.fn ? [...s.fn.locals, ...s.fn.params.filter((p) => p.kind === "number").map((p) => p.name)] : [])];
    return names.length ? { k: "bin", op: "+", l: { k: "var", name: r.pick(names) }, r: e } : e;
  };
  // (A comparison of two constants is a TypeScript error — "no overlap" — and an operation on two is worked out when the
  // script is built, by JavaScript's arithmetic: neither is made, so that what is compared is what the game computes.)
  const cmp = (s: Scope, depth: number): BExpr => {
    let l = num(s, depth);
    let right = num(s, depth);
    const op = r.pick(["<", "<=", ">", ">=", "==", "!="] as const);
    if (constLike(l) && constLike(right)) l = unconst(s, l);
    // (`x == 20` narrows x to 20 for TypeScript, and a later `x != -77` then has "no overlap": a constant compared for
    // equality is a constant plus z, which TypeScript cannot see through.)
    if (op === "==" || op === "!=") {
      if (constLike(right)) right = { k: "bin", op: "+", l: { k: "var", name: "z" }, r: right };
      if (constLike(l)) l = { k: "bin", op: "+", l: { k: "var", name: "z" }, r: l };
    }
    return { k: "cmp", op, l, r: right };
  };
  /** `cond`: where a condition of the game may stand (an if, a loop, a ternary) — a `Condition` is not a boolean value. */
  const bool = (s: Scope, depth: number, cond = false): BExpr => {
    const leaf = depth <= 0 || r.chance(0.3);
    const locals = s.fn ? s.fn.params.filter((p) => p.kind === "boolean").map((p) => p.name) : [];
    const leaves: (() => BExpr)[] = [() => cmp(s, depth - 1)];
    if (s.bools.length + locals.length) leaves.push(() => ({ k: "bvar", name: r.pick([...s.bools, ...locals]) }));
    if (r.chance(0.1)) leaves.push(() => ({ k: "bconst", v: r.chance(0.5) }));
    if (cond && r.chance(0.1)) leaves.push(() => ({ k: "switchIs", n: 1 + r.int(3) }));
    if (s.texts.length && r.chance(0.3)) leaves.push(() => {
      // (A variable against a literal narrows the variable's type to it, and a second literal then has "no overlap": a text
      // of the variable's made new — a template of it — is a string to TypeScript; a variable is compared with a variable.)
      const name = r.pick(s.texts);
      return r.chance(0.5) ? { k: "tcmp", op: r.pick(["===", "!=="]), l: { k: "tvar", name }, r: { k: "tvar", name: r.pick(s.texts) } } : { k: "tcmp", op: r.pick(["===", "!=="]), l: { k: "tmpl", parts: [{ k: "tvar", name }] }, r: text(s, 0) };
    });
    if (leaf) return r.pick(leaves)();
    const inner: (() => BExpr)[] = [
      () => ({ k: "and", items: [bool(s, depth - 1, cond), bool(s, depth - 1, cond)] }),
      () => ({ k: "or", items: [bool(s, depth - 1, cond), bool(s, depth - 1, cond)] }),
      () => ({ k: "not", e: bool(s, depth - 1, cond) }),
      () => cmp(s, depth - 1),
    ];
    const boolFns = s.calls.filter((f) => f.returns === "boolean");
    if (boolFns.length) inner.push(() => call(s, r.pick(boolFns), depth - 1) as BExpr);
    return r.pick(inner)();
  };
  const text = (s: Scope, depth: number): TExpr => {
    const leaves: (() => TExpr)[] = [() => ({ k: "tlit", s: r.pick(WORDS) })];
    if (s.texts.length) leaves.push(() => ({ k: "tvar", name: r.pick(s.texts) }), () => ({ k: "tvar", name: r.pick(s.texts) }));
    if (depth <= 0 || r.chance(0.4)) return r.pick(leaves)();
    const inner: (() => TExpr)[] = [
      () => ({ k: "tmpl", parts: [r.pick(WORDS), num(s, 1), ...(r.chance(0.5) ? [text(s, depth - 1)] : [])] }),
      () => ({ k: "ttern", c: bool(s, 1, true), t: text(s, depth - 1), f: text(s, depth - 1) }),
    ];
    return r.pick(inner)();
  };
  const printed = (s: Scope): Stmt => {
    const parts: (string | NExpr | TExpr)[] = [`${label}.${prints++}`];
    for (let i = 0, n = 1 + r.int(3); i < n; i++) {
      parts.push(" ");
      parts.push(r.chance(0.7) || !s.texts.length ? num(s, 1) : text(s, 1));
    }
    return { k: "print", parts };
  };

  const stmt = (s: Scope, depth: number, budget: { n: number }): Stmt => {
    budget.n--;
    const locals = s.fn ? s.fn.locals : [];
    const choices: (() => Stmt)[] = [];
    const targets = [...s.nums, ...locals];
    if (targets.length) choices.push(
      () => ({ k: "assign", name: r.pick(targets), op: r.pick(["=", "=", "+=", "-="]), e: num(s, 2) }),
      () => ({ k: "assign", name: r.pick(targets), op: "=", e: num(s, 3) }),
    );
    if (s.bools.length) choices.push(() => ({ k: "bassign", name: r.pick(s.bools), e: bool(s, 2) }));
    if (s.texts.length) choices.push(() => {
      const name = r.pick(s.texts);
      // (A made text grows by a few characters a turn: kept under forty, so no text nears what a made one holds.)
      const e = r.chance(0.5) ? text(s, 2) : { k: "tmpl", parts: [{ k: "tvar", name }, num(s, 1)] } as TExpr;
      return { k: "tassign", name, e: e.k === "tmpl" ? { k: "ttern", c: { k: "cmp", op: "<", l: { k: "tlen", text: { k: "tvar", name } }, r: { k: "const", v: 40 } }, t: e, f: { k: "tlit", s: r.pick(WORDS) } } : e };
    });
    if (s.records.length) choices.push(() => ({ k: "fassign", rec: r.pick(s.records), field: r.pick(["x", "y"]), op: r.pick(["=", "+="]), e: num(s, 2) }));
    if (s.fixed.length) choices.push(() => { const a = r.pick(s.fixed); return { k: "store", arr: a.name, idx: num(s, 1), mask: a.mask, e: num(s, 2) }; });
    if (s.growing.length) choices.push(() => ({ k: "push", arr: r.pick(s.growing), e: num(s, 2) }), () => ({ k: "gstore", arr: r.pick(s.growing), idx: num(pure(s), 1), e: num(pure(s), 2) }));
    const voidFns = s.calls.filter((f) => f.returns === "void");
    if (voidFns.length) choices.push(() => { const f = r.pick(voidFns); return { k: "callstmt", fn: f.name, args: (call(s, f, 1) as { args: Arg[] }).args }; });
    if (s.calls.length) choices.push(() => { const f = r.pick(s.calls); return { k: "callstmt", fn: f.name, args: (call(s, f, 1) as { args: Arg[] }).args }; });
    choices.push(() => printed(s));
    if (r.chance(0.15)) choices.push(() => ({ k: "setDeaths", unit: r.pick(UNITS), mod: r.pick(["add", "set", "subtract"]), e: { k: "bin", op: "&", l: num(s, 1), r: { k: "const", v: 255 } } }));
    if (r.chance(0.1)) choices.push(() => ({ k: "setSwitch", n: 1 + r.int(3), to: r.pick(["set", "clear", "toggle"]) }));
    if (s.loop && r.chance(0.3)) choices.push(() => ({ k: "break" }), () => ({ k: "continue" }));
    if (s.tried && r.chance(0.3)) choices.push(() => ({ k: "throw", what: r.pick(THROWS) }));
    if (s.top && r.chance(0.25)) choices.push(() => ({ k: "sleep", n: 1 + r.int(2) }));
    if (s.fn && s.fn.returns !== "void" && !s.finally && r.chance(0.15)) choices.push(() => ({ k: "return", e: s.fn!.returns === "number" ? num(s, 2) : bool(s, 2) }));
    if (depth > 0 && budget.n > 0) {
      const inner = (over: Partial<Scope>) => block({ ...s, ...over }, depth - 1, budget, 1 + r.int(3));
      choices.push(
        () => ({ k: "if", c: bool(s, 2, true), then: inner({}), ...(r.chance(0.5) ? { else: inner({}) } : {}) }),
        () => { const i = fresh("i"); const b = inner({ loop: true, ro: [...s.ro, i] }); return { k: "for", i, bound: r.chance(0.5) ? { k: "const", v: 1 + r.int(6) } : { k: "bin", op: "&", l: num(s, 1), r: { k: "const", v: 7 } }, body: b }; },
        () => ({ k: "while", c: bool(s, 2, true), guard: guard(), body: inner({ loop: true }) }),
        () => ({ k: "do", body: inner({ loop: true }), c: bool(s, 2, true), guard: guard() }),
        () => ({ k: "switch", e: { k: "bin", op: "&", l: num(s, 1), r: { k: "const", v: 3 } }, cases: [0, 1, 2].filter(() => r.chance(0.7)).map((v) => ({ v, body: inner({ loop: false }) })), def: inner({ loop: false }) }),
        // (No `finally` where a function that calls itself may be called inside the try: the error kept across the
        // finally is a text, which a map of our own does not keep on its stack — the plan's Open list, step 16.)
        () => ({ k: "try", body: inner({ tried: true }), catch: inner({}), ...(r.chance(0.4) && !anyRecursive ? { finally: inner({ tried: false, loop: false, finally: true }) } : {}) }),
      );
    }
    return r.pick(choices)();
  };
  const block = (s: Scope, depth: number, budget: { n: number }, n: number): Stmt[] => {
    const out: Stmt[] = [];
    for (let i = 0; i < n && budget.n > 0; i++) {
      const st = stmt(s, depth, budget);
      out.push(st);
      // (Nothing follows a break, a continue, a throw or a return in its block.)
      if (st.k === "break" || st.k === "continue" || st.k === "throw" || st.k === "return") break;
    }
    return out;
  };

  // The functions: each calls only those before it; one in three that gives a number calls itself, bounded by its first
  // parameter. (Which call themselves is decided first: a `finally` anywhere beside one is a text on the stack — see `try`.)
  const functions: Func[] = [];
  const shapes = Array.from({ length: r.int(4) }, () => { const returns = r.pick(["number", "number", "boolean", "void"] as const); return { returns, recursive: returns === "number" && r.chance(0.35) }; });
  const anyRecursive = shapes.some((f) => f.recursive);
  for (const { returns, recursive } of shapes) {
    const name = fresh("f");
    const params: Param[] = recursive ? [{ name: fresh("d"), kind: "number" }] : Array.from({ length: r.int(3) }, () => ({ name: fresh("a"), kind: r.chance(0.75) ? "number" : "boolean" }));
    const locals = Array.from({ length: r.int(3) }, () => fresh("l"));
    const f: Func = { name, params, locals, returns, body: [], recursive };
    // (No text made inside a function that calls itself: `t = \`${t}${f(d - 2)}\`` reads t after the inner call in the
    // simulator and the map, before it in JavaScript — the plan's Open list, step 16.)
    const inner: Scope = { ...scope, texts: recursive ? [] : scope.texts, calls: recursive ? [...functions, f] : [...functions], loop: false, tried: false, top: false, fn: f };
    const budget = { n: 4 + r.int(6) };
    if (recursive) {
      const d = params[0].name;
      f.body = [
        { k: "if", c: { k: "cmp", op: "<=", l: { k: "var", name: d }, r: { k: "const", v: 0 } }, then: [{ k: "return", e: num({ ...inner, calls: functions }, 1) }] },
        ...block(inner, 1, budget, 1 + r.int(2)).filter((s) => s.k !== "return"),
        { k: "return", e: { k: "bin", op: r.pick(["+", "-", "*", "^"]), l: { k: "call", fn: name, args: [{ k: "bin", op: "-", l: { k: "var", name: d }, r: { k: "const", v: 1 } }] }, r: num({ ...inner, calls: functions }, 1) } },
      ];
    } else {
      f.body = block(inner, 2, budget, 2 + r.int(3));
      if (f.body.at(-1)?.k === "return") f.body.pop();
      if (returns !== "void") f.body.push({ k: "return", e: returns === "number" ? num(inner, 2) : bool(inner, 2) });
    }
    functions.push(f);
  }
  scope.calls = functions;

  // The body: a few frames' worth, a line printed at the end of each, a sleep between.
  const body: Stmt[] = [];
  const frames = 3 + r.int(4);
  const budget = { n: 10 + r.int(20) };
  for (let f = 0; f < frames; f++) {
    body.push(...block(scope, 2, budget, 1 + r.int(4)));
    body.push(printed(scope));
    if (f < frames - 1) body.push({ k: "sleep", n: 1 + r.int(2) });
  }
  return { decls, functions, body };
}

/** `programs` programs of one seed, in one script (one compile, one map, their lines told apart by `p<index>`). */
export function randomScript(seed: number, programs = 3, frames = 12): Generated {
  const r = rng(seed * 7919 + 17);
  return { seed, programs: Array.from({ length: programs }, (_, i) => randomProgram(r, `s${seed}p${i}`)), frames };
}

// ── rendered as TrigScript and as JavaScript ──

type Mode = "ts" | "js";

const UNIT_INDEX: Record<string, number> = { TerranMarine: 0, ZergZergling: 37, ProtossZealot: 65 };

function rn(e: NExpr, m: Mode): string {
  switch (e.k) {
    case "const": return e.v < 0 ? `(${e.v})` : String(e.v);
    case "var": return e.name;
    case "neg": return m === "ts" ? `(-${rn(e.e, m)})` : `((-${rn(e.e, m)}) | 0)`;
    case "tern": return `(${rb(e.c, m)} ? ${rn(e.t, m)} : ${rn(e.f, m)})`;
    case "el": return `${e.arr}[${rn(e.idx, m)} & ${e.mask}]`;
    // (A read of an array that grows, inside its length; 0 when it is empty.)
    case "gel": return m === "ts" ? `(${e.arr}.length > 0 ? ${e.arr}[(${rn(e.idx, m)} & 1023) % ${e.arr}.length] : 0)` : `(${e.arr}.length > 0 ? ${e.arr}[__mod(${rn(e.idx, m)} & 1023, ${e.arr}.length)] : 0)`;
    case "len": return `${e.arr}.length`;
    case "tlen": return `${rt(e.text, m)}.length`;
    case "call": return `${e.fn}(${e.args.map((a) => ra(a, m)).join(", ")})`;
    case "math": return m === "ts" ? `Math.${e.fn}(${e.args.map((a) => rn(a, m)).join(", ")})` : `(Math.${e.fn}(${e.args.map((a) => rn(a, m)).join(", ")}) | 0)`;
    case "pop": return `(${e.arr}.pop() ?? 0)`;
    case "deaths": return m === "ts" ? `i32(deaths(P1, units.${e.unit}))` : `__deaths(${UNIT_INDEX[e.unit]})`;
    case "field": return `${e.rec}.${e.field}`;
    case "bin": {
      const l = rn(e.l, m), r = rn(e.r, m);
      // (`a << (b > (c))` is a generic call to TypeScript's parser too: the count written as a sum.)
      if (m === "ts") return `(${l} ${e.op} ${e.op === "<<" && r.startsWith("(") ? `(0 + ${r})` : r})`;
      switch (e.op) {
        case "+": case "-": return `((${l} ${e.op} ${r}) | 0)`;
        case "*": return `Math.imul(${l}, ${r})`;
        case "/": return `__div(${l}, ${r})`;
        case "%": return `__mod(${l}, ${r})`;
        case "<<": return `__shl(${l}, ${r})`;
        case ">>": return `__shr(${l}, ${r})`;
        default: return `(${l} ${e.op} ${r})`;
      }
    }
  }
}
function rb(e: BExpr, m: Mode): string {
  switch (e.k) {
    case "bconst": return String(e.v);
    case "bvar": return e.name;
    case "cmp": {
      const l = rn(e.l, m), r = rn(e.r, m);
      // (`a < b … > (` reads as a generic call to TypeScript's parser, whatever `a` is: `<` is never written — the sides
      // change places and the comparison turns around.)
      return e.op === "<" ? `(${r} > ${l})` : `(${l} ${e.op} ${r})`;
    }
    case "and": return `(${e.items.map((x) => rb(x, m)).join(" && ")})`;
    case "or": return `(${e.items.map((x) => rb(x, m)).join(" || ")})`;
    case "not": return `!${rb(e.e, m)}`;
    case "tcmp": return `(${rt(e.l, m)} ${e.op} ${rt(e.r, m)})`;
    case "bcall": return `${e.fn}(${e.args.map((a) => ra(a, m)).join(", ")})`;
    case "switchIs": return m === "ts" ? `switchIs(switches.Switch${e.n}, "set")` : `__switches[${e.n}]`;
  }
}
function rt(e: TExpr, m: Mode): string {
  switch (e.k) {
    case "tlit": return JSON.stringify(e.s);
    case "tvar": return e.name;
    case "tmpl": return "`" + e.parts.map((p) => (typeof p === "string" ? p : "${" + ("k" in p && isText(p) ? rt(p as TExpr, m) : rn(p as NExpr, m)) + "}")).join("") + "`";
    case "ttern": return `(${rb(e.c, m)} ? ${rt(e.t, m)} : ${rt(e.f, m)})`;
  }
}
const isText = (e: NExpr | TExpr | BExpr): e is TExpr => e.k === "tlit" || e.k === "tvar" || e.k === "tmpl" || e.k === "ttern";
const isBool = (e: Arg): e is BExpr => e.k === "bconst" || e.k === "bvar" || e.k === "cmp" || e.k === "and" || e.k === "or" || e.k === "not" || e.k === "tcmp" || e.k === "bcall" || e.k === "switchIs";
const ra = (a: Arg, m: Mode) => (isBool(a) ? rb(a, m) : rn(a, m));

function rs(s: Stmt, m: Mode, ind: string): string {
  const blk = (b: Stmt[]) => `{\n${b.map((x) => rs(x, m, ind + "  ")).join("")}${ind}}`;
  switch (s.k) {
    case "assign": return `${ind}${s.name} ${m === "ts" || s.op === "=" ? s.op : "="} ${m === "ts" || s.op === "=" ? rn(s.e, m) : `((${s.name} ${s.op[0]} ${rn(s.e, m)}) | 0)`};\n`;
    case "bassign": return `${ind}${s.name} = ${rb(s.e, m)};\n`;
    case "tassign": return `${ind}${s.name} = ${rt(s.e, m)};\n`;
    case "fassign": return `${ind}${s.rec}.${s.field} ${m === "ts" || s.op === "=" ? s.op : "="} ${m === "ts" || s.op === "=" ? rn(s.e, m) : `((${s.rec}.${s.field} + ${rn(s.e, m)}) | 0)`};\n`;
    case "if": return `${ind}if (${rb(s.c, m)}) ${blk(s.then)}${s.else ? ` else ${blk(s.else)}` : ""}\n`;
    // (The bound first: `i < (` would read as a generic call to TypeScript's parser.)
    case "for": return `${ind}for (let ${s.i} = 0; ${rn(s.bound, m)} > ${s.i}; ${s.i}++) ${blk(s.body)}\n`;
    case "while": return `${ind}while (${rb(s.c, m)}) {\n${ind}  ${s.guard} += 1;\n${ind}  if (${s.guard} > 12) break;\n${s.body.map((x) => rs(x, m, ind + "  ")).join("")}${ind}}\n`;
    case "do": return `${ind}do {\n${ind}  ${s.guard} += 1;\n${ind}  if (${s.guard} > 12) break;\n${s.body.map((x) => rs(x, m, ind + "  ")).join("")}${ind}} while (${rb(s.c, m)});\n`;
    case "switch": {
      const ends = (b: Stmt[]) => b.at(-1)?.k === "throw" || b.at(-1)?.k === "return";
      return `${ind}switch (${rn(s.e, m)}) {\n${s.cases.map((c) => `${ind}  case ${c.v}: ${ends(c.body) ? blk(c.body) : blk(c.body).replace(/}$/, "  break;\n" + ind + "  }")}\n`).join("")}${ind}  default: ${blk(s.def)}\n${ind}}\n`;
    }
    case "break": return `${ind}break;\n`;
    case "continue": return `${ind}continue;\n`;
    case "store": return `${ind}${s.arr}[${rn(s.idx, m)} & ${s.mask}] = ${rn(s.e, m)};\n`;
    case "gstore": return m === "ts" ? `${ind}if (${s.arr}.length > 0) ${s.arr}[(${rn(s.idx, m)} & 1023) % ${s.arr}.length] = ${rn(s.e, m)};\n` : `${ind}if (${s.arr}.length > 0) ${s.arr}[__mod(${rn(s.idx, m)} & 1023, ${s.arr}.length)] = ${rn(s.e, m)};\n`;
    case "push": return `${ind}${s.arr}.push(${rn(s.e, m)});\n`;
    case "callstmt": return `${ind}${s.fn}(${s.args.map((a) => ra(a, m)).join(", ")});\n`;
    case "try": return `${ind}try ${blk(s.body)} catch ${blk(s.catch)}${s.finally ? ` finally ${blk(s.finally)}` : ""}\n`;
    case "throw": return `${ind}throw new ${s.what}("thrown");\n`;
    case "print": return `${ind}${m === "ts" ? "print" : "__print"}(${rt({ k: "tmpl", parts: s.parts }, m)});\n`;
    case "sleep": return m === "ts" ? `${ind}sleep(frames(${s.n}));\n` : `${ind}yield ${s.n};\n`;
    case "setDeaths": return m === "ts" ? `${ind}setDeaths(P1, units.${s.unit}, ${JSON.stringify(s.mod)}, ${rn(s.e, m)});\n` : `${ind}__setDeaths(${UNIT_INDEX[s.unit]}, ${JSON.stringify(s.mod)}, ${rn(s.e, m)});\n`;
    case "setSwitch": return m === "ts" ? `${ind}setSwitch(switches.Switch${s.n}, ${JSON.stringify(s.to)});\n` : `${ind}__switches[${s.n}] = ${s.to === "set" ? "true" : s.to === "clear" ? "false" : `!__switches[${s.n}]`};\n`;
    case "return": return `${ind}return${s.e ? " " + ra(s.e, m) : ""};\n`;
  }
}

function renderDecl(d: Decl, m: Mode): string {
  switch (d.kind) {
    case "number": return `let ${d.name} = ${d.init as number < 0 ? `(${d.init})` : d.init};\n`;
    case "read": return m === "ts" ? `const ${d.name} = i32(deaths(P1, units.ProtossArchon));\n` : `const ${d.name} = 0;\n`;
    // (Not `let b = false`: TypeScript narrows the variable to that value, and `if (b)` then holds `never`. A test of z, 0 in the game.)
    case "boolean": return `let ${d.name} = (z ${d.init ? "==" : "!="} 0);\n`;
    case "text": return `let ${d.name}${m === "ts" ? ": string" : ""} = ${JSON.stringify(d.init)};\n`;
    case "fixed": return `const ${d.name} = [${(d.init as number[]).join(", ")}];\n`;
    case "growing": return `const ${d.name}${m === "ts" ? ": number[]" : ""} = [${(d.init as number[]).join(", ")}];\n`;
    case "record": return `const ${d.name} = { x: ${(d.init as number[])[0]}, y: ${(d.init as number[])[1]} };\n`;
  }
}
function renderFunc(f: Func, m: Mode): string {
  const params = f.params.map((p) => (m === "ts" ? `${p.name}: ${p.kind}` : p.name)).join(", ");
  const ret = m === "ts" ? `: ${f.returns}` : "";
  return `  function ${f.name}(${params})${ret} {\n${f.locals.map((l) => `    let ${l} = 0;\n`).join("")}${f.body.map((s) => rs(s, m, "    ")).join("")}  }\n`;
}
export function renderProgram(p: ProgramTree, m: Mode): string {
  const head = m === "ts" ? "program(() => {\n" : "function* () {\n";
  return `${head}${p.decls.map((d) => "  " + renderDecl(d, m)).join("")}${p.functions.map((f) => renderFunc(f, m)).join("")}${p.body.map((s) => rs(s, m, "  ")).join("")}${m === "ts" ? "});\n" : "}"}`;
}
/** The script as TrigScript: `programs` programs, each with a program of its own. */
export function renderScript(g: Generated): string {
  return g.programs.map((p) => renderProgram(p, "ts")).join("\n");
}

// ── run as JavaScript ──

const PRELUDE = `
const __div = (a, b) => (b === 0 ? 0 : (a / b) | 0);
const __mod = (a, b) => (b === 0 ? 0 : (a % b) | 0);
const __shl = (a, b) => { b >>>= 0; return b >= 32 ? 0 : (a << b) | 0; };
const __shr = (a, b) => { b >>>= 0; return b >= 32 ? (a < 0 ? -1 : 0) : a >> b; };
const __deathsTable = new Map();
const __deaths = (u) => (__deathsTable.get(u) ?? 0) | 0;
const __setDeaths = (u, mod, v) => { const was = __deathsTable.get(u) ?? 0; v = v >>> 0; __deathsTable.set(u, (mod === "set" ? v : mod === "add" ? (was + v) >>> 0 : Math.max(0, was - v)) >>> 0); };
const __switches = [false, false, false, false];
`;

/**
 * What JavaScript prints for the script, frame by frame: each program a generator, resumed in the order of the
 * programs on the frame its sleep ends; a line is `cycle:text`, as the simulator's events are read.
 */
export function runJs(g: Generated): string[] {
  const out: string[] = [];
  let cycle = 0;
  const print = (t: string) => out.push(`${cycle}:${t}`);
  // (One function holds every program, so the deaths table and the switches are the game's: one for all of them.)
  const all = new Function("__print", `${PRELUDE}\nreturn [${g.programs.map((p) => renderProgram(p, "js")).join(",\n")}];`)(print) as (() => Generator<number>)[];
  const runs = all.map((mk) => ({ gen: mk(), wake: 0, done: false }));
  for (cycle = 0; cycle < g.frames; cycle++) {
    for (const run of runs) {
      if (run.done || run.wake > cycle) continue;
      const r = run.gen.next();
      if (r.done) run.done = true;
      else run.wake = cycle + (r.value as number);
    }
  }
  return out;
}

// ── cut down ──

/** Every list of statements in the tree, with its owner, so one statement at a time can be taken out. */
function* bodies(p: ProgramTree): Generator<Stmt[]> {
  const walk = function* (b: Stmt[]): Generator<Stmt[]> {
    yield b;
    for (const s of b) {
      if (s.k === "if") { yield* walk(s.then); if (s.else) yield* walk(s.else); }
      else if (s.k === "for" || s.k === "while" || s.k === "do") yield* walk(s.body);
      else if (s.k === "switch") { for (const c of s.cases) yield* walk(c.body); yield* walk(s.def); }
      else if (s.k === "try") { yield* walk(s.body); yield* walk(s.catch); if (s.finally) yield* walk(s.finally); }
    }
  };
  yield* walk(p.body);
  for (const f of p.functions) yield* walk(f.body);
}

/**
 * The smallest script that still fails `fails`: whole programs first, then a statement at a time out of every body,
 * then an `if`/`try`/loop replaced by its own body, until nothing more can go. A `return` that ends a function's body
 * and the loop guards stay: without them the program would not be one.
 */
export function reduce(g: Generated, fails: (g: Generated) => boolean): Generated {
  let cur: Generated = structuredClone(g);
  // Whole programs.
  for (let i = cur.programs.length - 1; i >= 0 && cur.programs.length > 1; i--) {
    const t = { ...cur, programs: cur.programs.filter((_, k) => k !== i) };
    if (fails(t)) cur = t;
  }
  let changed = true;
  while (changed) {
    changed = false;
    for (const p of cur.programs) {
      for (const b of [...bodies(p)]) {
        for (let i = b.length - 1; i >= 0; i--) {
          const s = b[i];
          const last = i === b.length - 1 && s.k === "return";
          if (last) continue;
          const removed = b.splice(i, 1);
          if (fails(cur)) { changed = true; continue; }
          b.splice(i, 0, ...removed);
          // A compound statement replaced by its first body.
          const inner = s.k === "if" ? s.then : s.k === "for" || s.k === "while" || s.k === "do" ? s.body : s.k === "try" ? s.body : s.k === "switch" ? s.def : null;
          if (inner && inner.every((x) => x.k !== "break" && x.k !== "continue" && x.k !== "throw") && !(s.k === "for" && JSON.stringify(inner).includes(`"${s.i}"`))) {
            b.splice(i, 1, ...inner);
            if (fails(cur)) { changed = true; continue; }
            b.splice(i, inner.length, s);
          }
        }
      }
      // Functions nothing calls any more.
      for (let i = p.functions.length - 1; i >= 0; i--) {
        const f = p.functions[i];
        if (JSON.stringify([p.body, p.functions.filter((x) => x !== f)]).includes(`"fn":"${f.name}"`)) continue;
        p.functions.splice(i, 1);
        if (fails(cur)) { changed = true; continue; }
        p.functions.splice(i, 0, f);
      }
      // Declarations nothing names.
      for (let i = p.decls.length - 1; i >= 0; i--) {
        const d = p.decls[i];
        if (JSON.stringify([p.body, p.functions]).includes(`"${d.name}"`)) continue;
        p.decls.splice(i, 1);
        if (fails(cur)) { changed = true; continue; }
        p.decls.splice(i, 0, d);
      }
    }
  }
  return cur;
}
