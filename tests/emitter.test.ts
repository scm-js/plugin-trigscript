// The emitter (compiler/backend/emit.ts) against the meaning of the statements it lowers: random loops of numbers —
// sums, signed, unsigned and mixed comparisons at the edges, if and else, break and continue, loops inside loops —
// each run as written (a small evaluator here) and as the emitter's graph (a small interpreter of graph.ts's triggers:
// conditions compare memory with their own numbers, actions write memory, the walk follows next pointers), from the
// same random values, every variable compared after. The game probe probes/game-emitter.ts does the same in the
// lifted game, for fewer loops.
import { describe, expect, it } from "vitest";
import type { BoolExpr, NumExpr, Stmt, VarDecl } from "../compiler/ir";
import { emitLoop } from "../compiler/backend/emit";
import { END, type Dword, type Graph } from "../compiler/backend/graph";

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
    case "binary": {
      const a = num(e.left, env), b = num(e.right, env);
      if (e.op === "+") return u(a + b);
      if (e.op === "-") return u(a - b);
      if (e.op === "*") return u(Math.imul(a, b));
      if (e.op === "<<") return u(a << (b & 31));
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

// ── the graph, as the game runs its triggers ──

function key(d: Dword): string {
  if ("game" in d) return `game:${d.game}`;
  if ("var" in d) return `var:${d.var}`;
  if ("data" in d) return `data:${d.data}`;
  const f = d.field;
  return f === "next" ? `${d.at}|next` : "cond" in f ? `${d.at}|cond:${f.cond}` : `${d.at}|act:${f.act}:${f.part}`;
}

function exec(g: Graph, env: Env): Env {
  const mem = new Map<string, number | string>();
  for (const [id, v] of env) mem.set(`var:${id}`, v);
  g.triggers.forEach((t, i) => {
    mem.set(`${t.label}|next`, t.next ?? g.triggers[i + 1]?.label ?? END);
    t.conds.forEach((c, k) => mem.set(`${t.label}|cond:${k}`, c.value));
    t.acts.forEach((a, k) => mem.set(`${t.label}|act:${k}:value`, typeof a.value === "object" ? a.value.label : a.value));
  });
  const read = (k: string) => mem.get(k) ?? 0;
  for (const e of g.entries) mem.set(key(e.into), u(Math.imul(e.scale ?? 1, env.get(e.from) ?? 0) + e.add));
  const byLabel = new Map(g.triggers.map((t) => [t.label, t]));
  let pc = g.triggers[0].label;
  for (let steps = 0; pc !== END; steps++) {
    if (steps > 2_000_000) throw new Error("the graph does not end");
    const t = byLabel.get(pc)!;
    if (t.island) {
      // As the Python side does: the statement on the variables' cells.
      const cells: Env = new Map([...mem].filter(([k]) => k.startsWith("var:")).map(([k, x]) => [k.slice(4), x as number]));
      run([t.island], cells, { n: 1e6 });
      for (const [id, x] of cells) mem.set(`var:${id}`, x);
    }
    for (const c of t.copy?.into ?? []) mem.set(key(c.dword), u(Math.imul(c.scale ?? 1, read(`var:${t.copy!.from}`) as number) + c.add));
    const holds = t.conds.every((c, k) => {
      const mask = c.mask ?? U32 - 1;
      const x = Number(BigInt(read(key(c.dword)) as number) & BigInt(mask)), y = Number(BigInt(read(`${t.label}|cond:${k}`) as number) & BigInt(mask));
      return c.compare === "atLeast" ? x >= y : c.compare === "atMost" ? x <= y : x === y;
    });
    if (holds) t.acts.forEach((a, k) => {
      const v = read(`${t.label}|act:${k}:value`);
      const d = key(a.dword);
      if (typeof v === "string") { mem.set(d, v); return; }
      const old = read(d) as number;
      mem.set(d, a.modifier === "set" ? v : a.modifier === "add" ? u(old + v) : Math.max(0, old - v));
    });
    pc = read(`${t.label}|next`) as string;
  }
  const out: Env = new Map();
  for (const [k, v] of mem) if (k.startsWith("var:")) out.set(k.slice(4), v as number);
  return out;
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
  const v = (d: VarDecl): NumExpr => ({ kind: "var", id: d.id });
  const k = (n: number): NumExpr => ({ kind: "const", value: n });
  const bin = (op: "+" | "-" | "*" | "<<", left: NumExpr, right: NumExpr): NumExpr => ({ kind: "binary", op, left, right, at, label: "" });
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
  const cmp = (): BoolExpr => ({ kind: "compare", op: r.pick(["<", "<=", ">", ">=", "==", "!="] as const), left: side(), right: side(), ...(r.next() < 0.5 ? {} : { unsigned: r.pick([true, "left", "right"] as const) }), at, label: "" });
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
        // Now and then a product of two variables: a statement the emitter leaves to the Python side.
        out.push({ kind: "assign", target: t.id, value: r.next() < 0.15 ? bin("*", v(r.pick(vars)), v(r.pick(vars))) : value(t), at, label: "" });
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
  const env: Env = new Map(vars.map((d) => [d.id, u(r.next() < 0.5 ? r.pick(EDGES) : Math.floor(r.next() * U32))]));
  return { decls, outer, env };
}

describe("the emitter", () => {
  it("lowers random loops of numbers to graphs that leave every variable as the loops do", () => {
    let taken = 0;
    const left = new Map<string, number>();
    for (let seed = 1; seed <= 4000; seed++) {
      const { decls, outer, env } = program(seed);
      const [init, loop] = outer;
      const g = emitLoop(loop, decls, `s${seed}`);
      if (typeof g === "string") { left.set(g, (left.get(g) ?? 0) + 1); continue; }
      taken++;
      const want = new Map(env);
      run([init], want, { n: 1e6 });
      const start = new Map(want);
      run([loop], want, { n: 1e6 });
      const got = exec(g, start);
      if (process.env.EMITTER_SEED === String(seed)) console.log(JSON.stringify({ loop, env: [...start], g }, null, 1));
      for (const [id, value] of want) expect([seed, id, got.get(id) ?? 0]).toEqual([seed, id, value]);
    }
    if (process.env.EMITTER_LEFT) console.log(taken, [...left].sort((a, b) => b[1] - a[1]));
    expect(taken).toBeGreaterThan(3900);
  });
});
