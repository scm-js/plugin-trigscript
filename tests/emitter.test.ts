// The emitter (compiler/backend/emit.ts) against the meaning of the statements it lowers: random loops of numbers —
// sums, signed, unsigned and mixed comparisons at the edges, if and else, break and continue, loops inside loops —
// each run as written (a small evaluator here) and as the emitter's graph (a small interpreter of graph.ts's triggers:
// conditions compare memory with their own numbers, actions write memory, the walk follows next pointers), from the
// same random values, every variable compared after. The game probe probes/game-emitter.ts does the same in the
// lifted game, for fewer loops.
import { describe, expect, it } from "vitest";
import type { ArrayDecl, BoolExpr, FuncDecl, NumExpr, Stmt, VarDecl } from "../compiler/ir";
import { emitLoop, emitterCounts } from "../compiler/backend/emit";
import { END, type Dword, type Graph, type Num } from "../compiler/backend/graph";
import { fixedDiv, fixedMul } from "../compiler/fixedMath";

const U32 = 2 ** 32;
const u = (n: number) => ((n % U32) + U32) % U32;
const at = { file: "main.ts", line: 1, column: 1 };

// ── the statements, as written ──

type Env = Map<string, number>;

function num(e: NumExpr, env: Env): number {
  switch (e.kind) {
    case "const": return u(e.value);
    case "var": return env.get(e.id) ?? 0;
    case "unary": return u(-num(e.expr, env));
    case "cast": return num(e.expr, env);
    case "intrinsic": {
      const [a, b] = e.args.map((x) => num(x, env));
      if (e.name === "abs") return u(Math.abs(a | 0));
      if (e.name === "min" || e.name === "max") {
        const [x, y] = e.unsigned ? [a, b] : [a | 0, b | 0];
        return u(e.name === "min" ? Math.min(x, y) : Math.max(x, y));
      }
      return u(e.name === "fmul" ? fixedMul(a | 0, b | 0) : fixedDiv(a | 0, b | 0));
    }
    case "ternary": return bool(e.cond, env) ? num(e.whenTrue, env) : num(e.whenFalse, env);
    case "element": {
      const i = num(e.index, env);
      const values = TABLES.get(e.array);
      if (values) return i < values.length ? u(values[i]) : 0;
      return i < WRITABLE.get(e.array)! ? env.get(cellKey(e.array, i)) ?? 0 : 0;
    }
    case "call": {
      const f = FUNCTIONS.get(e.call.fn!)!;
      const inner = new Map(env);
      e.call.params.forEach((p, k) => inner.set(f.params[k].id, num(p.init as NumExpr, env)));
      const ret = f.body.find((x) => x.kind === "return") as Extract<Stmt, { kind: "return" }>;
      return num(ret.value as NumExpr, inner);
    }
    case "binary": {
      const a = num(e.left, env), b = num(e.right, env);
      if (e.op === "+") return u(a + b);
      if (e.op === "-") return u(a - b);
      if (e.op === "*") return u(Math.imul(a, b));
      if (e.op === "<<") return u(a << (b & 31));
      if (e.op === ">>") return u((a | 0) >> (b & 31));
      if (e.op === ">>>") return u(a >>> (b & 31));
      if (e.op === "&") return u(a & b);
      throw new Error(e.op);
    }
    default: throw new Error(e.kind);
  }
}

function compare(op: string, x: number, y: number): boolean {
  return op === "<" ? x < y : op === "<=" ? x <= y : op === ">" ? x > y : op === ">=" ? x >= y : op === "==" ? x === y : x !== y;
}

function bool(e: BoolExpr, env: Env): boolean {
  switch (e.kind) {
    case "const": return e.value;
    case "not": return !bool(e.expr, env);
    case "and": return e.items.every((x) => bool(x, env));
    case "or": return e.items.some((x) => bool(x, env));
    case "test": return num(e.expr, env) !== 0;
    case "compare": {
      const a = num(e.left, env), b = num(e.right, env);
      if (e.unsigned === true) return compare(e.op, a, b);
      if (e.unsigned === "left") return (b | 0) < 0 ? compare(e.op, 1, 0) : compare(e.op, a, b);
      if (e.unsigned === "right") return (a | 0) < 0 ? compare(e.op, 0, 1) : compare(e.op, a, b);
      return compare(e.op, a | 0, b | 0);
    }
    default: throw new Error(e.kind);
  }
}

type Flow = "next" | "break" | "continue";
function run(list: Stmt[], env: Env, budget: { n: number }): Flow {
  for (const s of list) {
    if (--budget.n < 0) throw new Error("too long");
    switch (s.kind) {
      case "declare": env.set(s.decl.id, num(s.init as NumExpr, env)); break;
      case "assign": env.set(s.target, num(s.value, env)); break;
      case "store": {
        const i = num(s.index, env), v = num(s.value as NumExpr, env);
        if (i < WRITABLE.get(s.array)!) env.set(cellKey(s.array, i), v);
        break;
      }
      case "block": { const f = run(s.body, env, budget); if (f !== "next") return f; break; }
      case "if": { const f = run(bool(s.cond, env) ? s.then : s.else ?? [], env, budget); if (f !== "next") return f; break; }
      case "break": return "break";
      case "continue": return "continue";
      case "while": case "for":
        while (!s.cond || bool(s.cond, env)) {
          if (run(s.body, env, budget) === "break") break;
          if (s.kind === "for") run(s.update, env, budget);
        }
        break;
      case "do":
        do { if (run(s.body, env, budget) === "break") break; } while (bool(s.cond, env));
        break;
      default: throw new Error(s.kind);
    }
  }
  return "next";
}

// The program's lists known when it is built, and its functions (the random programs set them), for both runs.
const TABLES = new Map<string, number[]>();
const FUNCTIONS = new Map<string, FuncDecl>();
/** The program's arrays a program stores into, by id: their lengths. A cell's value is in the environment. */
const WRITABLE = new Map<string, number>();
const cellKey = (id: string, i: number) => `cell:${id}:${i}`;
/** The variables some array is indexed by (the Python side may keep offsets beside them). */
const INDEXED = new Set<string>();

// ── the graph, as the game runs its triggers ──

/** Where a list's first cell is, as an EPD, and how far apart its cells are, for the interpreter's memory. */
const TABLE_EPD = (id: string) => 0x100000 * (1 + [...TABLES.keys(), ...WRITABLE.keys()].indexOf(id));
/** A writable array's cells in the interpreter's memory: an EUDVArray's, 18 EPD apart. */
const cellEpd = (id: string, i: number) => `epd:${TABLE_EPD(id) + 18 * i}`;
const numOf = (n: Num): number => (typeof n === "number" ? n : u(TABLE_EPD(n.epdOf) + n.plus));

function key(d: Dword): string {
  if ("game" in d) return `game:${d.game}`;
  if ("var" in d) return `var:${d.var}`;
  if ("data" in d) return `data:${d.data}`;
  if ("element" in d) throw new Error("an element is read through a condition's player field");
  if ("param" in d) return `param:${d.param.fn}:${d.param.c ?? ""}:${d.index}`;
  if ("counter" in d) return `counter:${d.counter}:${d.part}`;
  const f = d.field;
  return f === "next" ? `${d.at}|next` : "cond" in f ? `${d.at}|cond:${f.cond}${f.part === "player" ? ":player" : ""}` : `${d.at}|act:${f.act}:${f.part}`;
}

function exec(g: Graph, env: Env): Env {
  const mem = new Map<string, number | string>();
  for (const [id, v] of env) if (!id.startsWith("cell:")) mem.set(`var:${id}`, v);
  // The Python side's offsets beside a counter an array is indexed by, as it keeps them (72 and 18 times it).
  for (const id of INDEXED) mem.set(`counter:${id}:bytes`, u(Math.imul(72, env.get(id) ?? 0))), mem.set(`counter:${id}:dwords`, u(Math.imul(18, env.get(id) ?? 0)));
  for (const [id, n] of WRITABLE) for (let i = 0; i < n; i++) mem.set(cellEpd(id, i), env.get(cellKey(id, i)) ?? 0);
  /** The variables and the writable arrays' cells, as the environment has them. */
  const asEnv = (): Env => {
    const out: Env = new Map([...mem].filter(([k]) => k.startsWith("var:")).map(([k, x]) => [k.slice(4), x as number]));
    for (const [id, n] of WRITABLE) for (let i = 0; i < n; i++) out.set(cellKey(id, i), mem.get(cellEpd(id, i)) as number);
    return out;
  };
  // The lists, where the graph says the Python side keeps them.
  for (const { id, stride } of g.arrays ?? []) TABLES.get(id)?.forEach((v, i) => mem.set(`epd:${TABLE_EPD(id) + stride * i}`, u(v)));
  g.triggers.forEach((t, i) => {
    mem.set(`${t.label}|next`, t.next ?? g.triggers[i + 1]?.label ?? END);
    t.conds.forEach((c, k) => {
      mem.set(`${t.label}|cond:${k}`, c.value);
      if ("element" in c.dword) mem.set(`${t.label}|cond:${k}:player`, TABLE_EPD(c.dword.element));
    });
    t.acts.forEach((a, k) => {
      mem.set(`${t.label}|act:${k}:value`, typeof a.value === "object" && "label" in a.value ? a.value.label : numOf(a.value));
      // (A store's destination: an EPD its index's writes keep.)
      if ("element" in a.dword) mem.set(`${t.label}|act:${k}:dest`, TABLE_EPD(a.dword.element));
    });
  });
  const read = (k: string) => mem.get(k) ?? 0;
  for (const e of g.entries) mem.set(key(e.into), u(Math.imul(e.scale ?? 1, env.get(e.from) ?? 0) + numOf(e.add)));
  const byLabel = new Map(g.triggers.map((t) => [t.label, t]));
  let pc = g.triggers[0].label;
  for (let steps = 0; pc !== END; steps++) {
    if (steps > 2_000_000) throw new Error("the graph does not end");
    const t = byLabel.get(pc)!;
    if (t.island) {
      // As the Python side does: the statement on the variables' cells.
      const cells = asEnv();
      run([t.island], cells, { n: 1e6 });
      for (const [id, x] of cells) {
        if (!id.startsWith("cell:")) {
          mem.set(`var:${id}`, x);
          // (The Python side steps the offsets it keeps beside a counter at its own stores of it.)
          if (INDEXED.has(id)) mem.set(`counter:${id}:bytes`, u(Math.imul(72, x))), mem.set(`counter:${id}:dwords`, u(Math.imul(18, x)));
          continue;
        }
        const [, arr, i] = id.split(":");
        mem.set(cellEpd(arr, Number(i)), x);
      }
    }
    if (t.call) {
      // As the Python side's function does: from its parameters' cells, into the dword the call names.
      const arg = (i: number) => (read(`param:${t.call!.fn}:${t.call!.c ?? ""}:${i}`) as number) | 0;
      const c = t.call.c ?? 0, f = t.call.fn;
      const r = f === "fmul_vars" ? fixedMul(arg(0), arg(1)) : f === "fdiv_vars" ? fixedDiv(arg(0), arg(1)) : f === "fmul_by" ? fixedMul(arg(0), c) : f === "fdiv_by" ? fixedDiv(c, arg(0)) : fixedDiv(arg(0), c);
      mem.set(key(t.call.into), u(r));
    }
    for (const c of t.copy?.into ?? []) mem.set(key(c.dword), u(Math.imul(c.scale ?? 1, read(`var:${t.copy!.from}`) as number) + numOf(c.add)));
    // The game stops at the first condition that fails; a masked one compares the dword's bits of the mask with the
    // number as it is.
    const holds = t.conds.every((c, k) => {
      let at: string;
      if ("element" in c.dword) {
        at = `epd:${read(`${t.label}|cond:${k}:player`)}`;
        if (!mem.has(at)) throw new Error(`a read outside the list: ${at}`);
      } else at = key(c.dword);
      const x = c.mask === undefined ? (read(at) as number) : Number(BigInt(read(at) as number) & BigInt(c.mask)), y = read(`${t.label}|cond:${k}`) as number;
      return c.compare === "atLeast" ? x >= y : c.compare === "atMost" ? x <= y : x === y;
    });
    if (holds) t.acts.forEach((a, k) => {
      const v = read(`${t.label}|act:${k}:value`);
      const d = "element" in a.dword ? `epd:${read(`${t.label}|act:${k}:dest`)}` : key(a.dword);
      if ("element" in a.dword && !mem.has(d)) throw new Error(`a store outside the array: ${d}`);
      if (typeof v === "string") { mem.set(d, v); return; }
      const old = read(d) as number;
      mem.set(d, a.modifier === "set" ? v : a.modifier === "add" ? u(old + v) : Math.max(0, old - v));
    });
    pc = read(`${t.label}|next`) as string;
  }
  // (Those offsets still 72 and 18 times their counters.)
  for (const id of INDEXED) {
    const v = (mem.get(`var:${id}`) as number) ?? 0;
    if (mem.get(`counter:${id}:bytes`) !== u(Math.imul(72, v)) || mem.get(`counter:${id}:dwords`) !== u(Math.imul(18, v))) throw new Error(`the offsets beside ${id} are not its`);
  }
  return asEnv();
}

// ── random loops ──

function rng(seed: number) {
  let s = seed >>> 0 || 1;
  const next = () => { s ^= s << 13; s >>>= 0; s ^= s >> 17; s ^= s << 5; s >>>= 0; return s / U32; };
  return { next, int: (n: number) => Math.floor(next() * n), pick: <T,>(xs: readonly T[]) => xs[Math.floor(next() * xs.length)] };
}

const EDGES = [0, 1, -1, 2, 7, -7, 100, 2147483647, -2147483648, 2147483646, -2147483647];

function program(seed: number) {
  const r = rng(seed);
  const decls = new Map<string, VarDecl>();
  const decl = (name: string): VarDecl => {
    const d: VarDecl = { id: `${name}#${decls.size}`, name, kind: "number", shared: false, at };
    decls.set(d.id, d);
    return d;
  };
  const vars = ["a", "b", "c", "d", "e"].map(decl);
  // Two lists known when the program is built, a short one (the Python side's EUDVArray) and a long one (packed), and
  // a function that is one return of a cell of one.
  TABLES.clear();
  FUNCTIONS.clear();
  WRITABLE.clear();
  const arrays = new Map<string, ArrayDecl>();
  for (const [name, length] of [["T", 5 + r.int(9)], ["L", 256 + r.int(40)]] as const) {
    // (Mostly small numbers, which the emitter reads where they are; now and then a wide one, which it leaves.)
    const values = Array.from({ length }, () => (r.next() < 0.03 ? r.pick(EDGES) : r.int(r.next() < 0.5 ? 4 : 60)));
    const a: ArrayDecl = { id: `${name}#t`, name, kind: "number", length, shared: true, values, at } as ArrayDecl;
    arrays.set(a.id, a);
    TABLES.set(a.id, values);
  }
  // An array the program stores into (and reads, which the emitter leaves to the Python side).
  const W = { id: "W#w", name: "W", kind: "number", length: 4 + r.int(7), shared: true, at } as ArrayDecl;
  arrays.set(W.id, W);
  WRITABLE.set(W.id, W.length);
  const fp = decl("p"), fq = decl("q");
  const cellAt: FuncDecl = { id: "cellAt#f", name: "cellAt", params: [fp, fq], body: [{ kind: "return", value: { kind: "element", array: "L#t", index: { kind: "binary", op: "+", left: { kind: "binary", op: "*", left: { kind: "var", id: fp.id }, right: { kind: "const", value: 16 }, at, label: "" }, right: { kind: "var", id: fq.id }, at, label: "" }, at }, at, label: "" }], at } as FuncDecl;
  FUNCTIONS.set(cellAt.id, cellAt);
  const v = (d: VarDecl): NumExpr => ({ kind: "var", id: d.id });
  const k = (n: number): NumExpr => ({ kind: "const", value: n });
  const bin = (op: "+" | "-" | "*" | "<<" | ">>" | ">>>" | "&", left: NumExpr, right: NumExpr): NumExpr => ({ kind: "binary", op, left, right, at, label: "" });
  let counters = 0;
  const busy = new Set<string>();
  const free = () => vars.filter((d) => !busy.has(d.id));
  const value = (target: VarDecl): NumExpr => {
    switch (r.int(9)) {
      case 7: return bin("*", v(r.pick(vars)), k(r.pick([3, -1, 2, 65536, -7, 0x7fffffff])));
      case 8: return bin("+", bin("<<", v(r.pick(vars)), k(r.int(32))), bin("*", k(r.pick([5, -3])), v(r.pick(vars))));
      case 0: return k(r.pick(EDGES));
      case 1: return v(r.pick(vars));
      case 2: return bin("+", v(r.pick(vars)), k(r.pick(EDGES)));
      case 3: return bin("-", v(r.pick(vars)), v(r.pick(vars)));
      case 4: return bin("+", bin("+", v(r.pick(vars)), v(r.pick(vars))), k(r.int(10)));
      case 5: return { kind: "unary", op: "-", expr: v(r.pick(vars)), at };
      default: return bin(r.next() < 0.5 ? "+" : "-", v(target), r.next() < 0.5 ? k(r.pick(EDGES)) : v(r.pick(vars.filter((x) => x !== target))));
    }
  };
  const side = (): NumExpr => (r.next() < 0.6 ? (r.next() < 0.3 ? bin("+", v(r.pick(vars)), k(r.pick(EDGES))) : v(r.pick(vars))) : k(r.pick(EDGES)));
  const cmp = (): BoolExpr => r.next() < 0.15
    // A variable's bits under a mask against a constant (`(frame & 2) != 0`).
    ? { kind: "compare", op: r.pick(["<", "<=", ">", ">=", "==", "!="] as const), left: bin("&", v(r.pick(vars)), k(r.pick([1, 2, 6, 0xff, 0x7fffffff, -2147483648, 0x30]))), right: k(r.pick([0, 0, 2, 1, 6, 0x10, -1, 0x7fffffff])), ...(r.next() < 0.5 ? {} : { unsigned: true }), at, label: "" }
    : { kind: "compare", op: r.pick(["<", "<=", ">", ">=", "==", "!="] as const), left: side(), right: side(), ...(r.next() < 0.5 ? {} : { unsigned: r.pick([true, "left", "right"] as const) }), at, label: "" };
  const cond = (depth: number): BoolExpr => {
    const x = r.int(10);
    if (depth > 1 || x < 6) return cmp();
    if (x < 8) return { kind: r.next() < 0.5 ? "and" : "or", items: [cond(depth + 1), cond(depth + 1), ...(r.next() < 0.3 ? [cond(depth + 1)] : [])] };
    if (x < 9) return { kind: "not", expr: cond(depth + 1) };
    return { kind: "test", expr: side(), at, label: "" };
  };
  const block = (depth: number, inLoop: boolean): Stmt[] => {
    const out: Stmt[] = [];
    for (let n = 1 + r.int(4); n > 0; n--) {
      const x = r.int(12);
      const f = free();
      if (x < 5 && f.length) {
        const t = r.pick(f);
        // Now and then a product of two variables (a statement the emitter leaves to the Python side), a cell of a list,
        // a call of a function that is a cell of one.
        const y = r.next();
        const index = (): NumExpr => (r.next() < 0.5 ? bin("+", v(r.pick(vars)), k(r.int(4))) : bin("-", v(r.pick(vars)), v(r.pick(vars))));
        const pick: NumExpr = y < 0.12 ? bin("*", v(r.pick(vars)), v(r.pick(vars)))
          : y < 0.24 ? { kind: "element", array: r.pick(["T#t", "L#t", "W#w"]), index: index(), at }
          : y < 0.4 ? { kind: "intrinsic", name: r.pick(["fmul", "fdiv"] as const), args: [r.next() < 0.3 ? k(r.pick([65536, 3 << 15, 7, -65536, 100 << 16])) : v(r.pick(vars)), r.next() < 0.3 ? k(r.pick([65536, 3 << 15, 7, -65536, 100 << 16])) : bin("+", v(r.pick(vars)), k(r.int(3)))], at, label: "" }
          : y < 0.46 ? bin("+", bin(r.pick([">>", ">>>"] as const), r.next() < 0.5 ? v(r.pick(vars)) : bin("-", v(r.pick(vars)), k(r.pick(EDGES))), k(1 + r.int(31))), bin("*", v(r.pick(vars)), k(r.pick([1, 65536, 3]))))
          : y < 0.58 ? (r.next() < 0.5
            ? { kind: "ternary", cond: cond(1), whenTrue: value(t), whenFalse: bin("+", { kind: "intrinsic", name: "abs", args: [v(r.pick(vars))], at, label: "" }, k(r.int(5))), at, label: "" }
            : { kind: "intrinsic", name: r.pick(["min", "max", "abs"] as const), args: [r.next() < 0.5 ? v(r.pick(vars)) : { kind: "intrinsic", name: "fdiv", args: [k(65536), v(r.pick(vars))], at, label: "" }, bin("+", v(r.pick(vars)), k(r.pick(EDGES)))], ...(r.next() < 0.3 ? { unsigned: true } : {}), at, label: "" })
          : y < 0.62 ? { kind: "call", call: { name: "cellAt", fn: "cellAt#f", at, label: "", params: [{ decl: fp, init: v(r.pick(vars)), label: "" }, { decl: fq, init: bin("+", v(r.pick(vars)), k(r.int(3))), label: "" }], body: [], result: { decl: decl("(cellAt result)"), kind: "number" } } }
          : value(t);
        out.push({ kind: "assign", target: t.id, value: pick, at, label: "" });
      }
      else if (x === 5 && r.next() < 0.6) {
        // A store: at a variable, a sum, past either end now and then; of a variable, a sum, a constant, a cell.
        const index: NumExpr = r.next() < 0.5 ? v(r.pick(vars)) : bin("+", v(r.pick(vars)), k(r.int(5) - 1));
        const t = r.pick(vars);
        const stored: NumExpr = r.next() < 0.2 ? { kind: "element", array: "W#w", index: v(r.pick(vars)), at } : r.next() < 0.5 ? value(t) : k(r.pick(EDGES));
        out.push({ kind: "store", array: "W#w", index, value: stored, at, label: "" });
      }
      else if (x < 8 && depth < 3) out.push({ kind: "if", cond: cond(0), then: block(depth + 1, inLoop), ...(r.next() < 0.5 ? { else: block(depth + 1, inLoop) } : {}), at, label: "" });
      else if (x < 10 && depth < 2) out.push(...loop(depth + 1));
      else if (inLoop) out.push({ kind: "if", cond: cond(0), then: [{ kind: r.next() < 0.5 ? "break" : "continue", at, label: "" }], at, label: "" });
    }
    return out;
  };
  /** A loop that ends: a counter of its own up to a small bound, which nothing else writes. */
  function loop(depth: number): Stmt[] {
    const c = decl(`i${counters++}`);
    busy.add(c.id);
    const bound = 1 + r.int(6);
    const unsigned = r.pick([undefined, true, "left"] as const);
    const test: BoolExpr = { kind: "compare", op: r.pick(["<", "<="] as const), left: v(c), right: k(bound), ...(unsigned === undefined ? {} : { unsigned }), at, label: "" };
    const step: Stmt = { kind: "assign", target: c.id, value: bin("+", v(c), k(1)), at, label: "" };
    const body = block(depth, true);
    busy.delete(c.id);
    const init: Stmt = { kind: "declare", decl: c, init: k(r.int(3)), at, label: "" };
    const kind = r.int(3);
    if (kind === 0) return [init, { kind: "for", cond: test, update: [step], body, at, label: "" }];
    if (kind === 1) return [init, { kind: "while", cond: test, body: [step, ...body], at, label: "" }];
    return [init, { kind: "do", body: [step, ...body], cond: test, at, label: "", condLabel: "" }];
  }
  const outer = loop(0);
  // Small values often, so that indexes land inside the lists too.
  const env: Env = new Map(vars.map((d) => [d.id, u(r.next() < 0.4 ? r.int(20) : r.next() < 0.5 ? r.pick(EDGES) : Math.floor(r.next() * U32))]));
  for (let i = 0; i < W.length; i++) env.set(cellKey(W.id, i), u(r.pick(EDGES)));
  return { decls, outer, env, arrays };
}

describe("the emitter", () => {
  it("lowers random loops of numbers to graphs that leave every variable as the loops do", () => {
    let taken = 0, stores = 0;
    const left = new Map<string, number>();
    for (let seed = 1; seed <= 4000; seed++) {
      const { decls, outer, env, arrays } = program(seed);
      const [init, loop] = outer;
      INDEXED.clear();
      const indexes = (x: unknown): void => {
        if (!x || typeof x !== "object") return;
        if (Array.isArray(x)) { x.forEach(indexes); return; }
        const o = x as Record<string, unknown>;
        if ((o.kind === "element" || o.kind === "store") && (o.index as NumExpr)?.kind === "var") INDEXED.add((o.index as { id: string }).id);
        Object.values(o).forEach(indexes);
      };
      indexes([loop, ...FUNCTIONS.values()]);
      const g = emitLoop(loop, decls, `s${seed}`, FUNCTIONS, INDEXED, arrays);
      if (typeof g === "string") { left.set(g, (left.get(g) ?? 0) + 1); continue; }
      taken++;
      if (g.triggers.some((t) => t.acts.some((a) => "element" in a.dword))) stores++;
      const want = new Map(env);
      run([init], want, { n: 1e6 });
      const start = new Map(want);
      run([loop], want, { n: 1e6 });
      if (process.env.EMITTER_SEED === String(seed)) console.log(JSON.stringify({ loop, env: [...start], g }, null, 1));
      let got: Env;
      try { got = exec(g, start); } catch (err) { throw new Error(`seed ${seed}: ${(err as Error).message}`); }

      for (const [id, value] of want) expect([seed, id, got.get(id) ?? 0]).toEqual([seed, id, value]);
    }
    if (process.env.EMITTER_LEFT) console.log(taken, stores, emitterCounts.hoisted, [...left].sort((a, b) => b[1] - a[1]));
    expect(emitterCounts.hoisted).toBeGreaterThan(200);
    expect(taken).toBeGreaterThan(3900);
    expect(stores).toBeGreaterThan(1000);
  });
});
