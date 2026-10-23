// The emitter (compiler/backend/emit.ts) against the meaning of the statements it lowers: random loops of numbers —
// sums, signed, unsigned and mixed comparisons at the edges, if and else, break and continue, loops inside loops —
// each run as written (a small evaluator here) and as the emitter's graph (a small interpreter of graph.ts's triggers:
// conditions compare memory with their own numbers, actions write memory, the walk follows next pointers), from the
// same random values, every variable compared after. The game probe probes/game-emitter.ts does the same in the
// lifted game, for fewer loops.
import { readFileSync, writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { ArrayDecl, BoolExpr, Call, FuncDecl, NumExpr, Stmt, TextPart, VarDecl } from "../compiler/ir";
import { emitBody, emitLoop, emitterCounts } from "../compiler/backend/emit";
import type { ConditionRecord } from "../vendor/triggers";
import { END, SWITCHES, TRIGGER_BYTES, type Dword, type Graph, type Num } from "../compiler/backend/graph";
import { layout } from "../compiler/backend/layout";
import { fixedAtan2, fixedDiv, fixedMul, fixedSin, fixedSqrt, fixedText } from "../compiler/fixedMath";
import { SIN_SCALE, atanTable, sinTable } from "../compiler/numbers";
import ts from "typescript";
import { compileScript } from "../compiler/compiler";
import { defaultScriptNames } from "../compiler/names";
import { emitOwn } from "../compiler/backend/own";
import { simulatePrograms } from "../compiler/simulateIr";
import { Simulation } from "../compiler/simulate";
import type { SimBounds, SimUnitInit } from "../compiler/world";
import { defaultLib } from "../bundle/lib.mjs";

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
      if (e.name === "fmul" || e.name === "fdiv") {
        see(e.args[0], a); see(e.args[1], b);
        const r = u(e.name === "fmul" ? fixedMul(a | 0, b | 0) : fixedDiv(a | 0, b | 0));
        see(e, r);
        return r;
      }
      if (e.name === "sin" || e.name === "cos" || e.name === "atan2") {
        see(e.args[0], a); see(e.args[1], b);
        const r = u(e.name === "atan2" ? fixedAtan2(a | 0, b | 0, TABLES.get(e.table!)!) : fixedSin(a | 0, b | 0, TABLES.get(e.table!)!, e.name === "cos"));
        see(e, r);
        return r;
      }
      if (e.name === "sqrt") {
        see(e.args[0], a);
        const r = u(fixedSqrt(a | 0, !!e.unsigned));
        see(e, r);
        return r;
      }
      if (e.name === "abs") return u(Math.abs(a | 0));
      if (e.name === "min" || e.name === "max") {
        const [x, y] = e.unsigned ? [a, b] : [a | 0, b | 0];
        return u(e.name === "min" ? Math.min(x, y) : Math.max(x, y));
      }
      throw new Error(e.name);
    }
    case "ternary": return bool(e.cond, env) ? num(e.whenTrue, env) : num(e.whenFalse, env);
    case "element": {
      const i = num(e.index, env);
      see(e.index, i);
      const values = TABLES.get(e.array);
      if (values) return i < values.length ? u(values[i]) : 0;
      return i < WRITABLE.get(e.array)! ? env.get(cellKey(e.array, i)) ?? 0 : 0;
    }
    case "call": {
      if (CALLS.whole) return callValue(e.call, env);
      const f = FUNCTIONS.get(e.call.fn!)!;
      const inner = new Map(env);
      e.call.params.forEach((p, k) => inner.set(f.params[k].id, num(p.init as NumExpr, env)));
      const ret = f.body.find((x) => x.kind === "return") as Extract<Stmt, { kind: "return" }>;
      return num(ret.value as NumExpr, inner);
    }
    case "binary": {
      const a = num(e.left, env), b = num(e.right, env);
      if (e.op === "*" || e.op === "/" || e.op === "%") { see(e.left, a); see(e.right, b); }
      if (e.op === "/" || e.op === "%") {
        const r = b === 0 ? 0 : u(e.unsigned ? (e.op === "/" ? Math.trunc(a / b) : a % b) : (e.op === "/" ? Math.trunc((a | 0) / (b | 0)) : (a | 0) % (b | 0)));
        see(e, r);
        return r;
      }
      if (e.op === "*") { const r = u(Math.imul(a, b)); see(e, r); return r; }
      if (e.op === "+") return u(a + b);
      if (e.op === "-") return u(a - b);
      if (e.op === "<<" || e.op === ">>" || e.op === ">>>") {
        see(e.left, a); see(e.right, b);
        // (A count of 32 or more, read from 0 up, leaves nothing — or the sign, for `>>` — as TrigScript has it.)
        const r = b >= 32 ? (e.op === ">>" && (a | 0) < 0 ? U32 - 1 : 0) : u(e.op === "<<" ? a << b : e.op === ">>" ? (a | 0) >> b : a >>> b);
        see(e, r);
        return r;
      }
      if (e.op === "&" || e.op === "|" || e.op === "^") {
        see(e.left, a); see(e.right, b);
        const r = u(e.op === "&" ? a & b : e.op === "|" ? a | b : a ^ b);
        see(e, r);
        return r;
      }
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
    case "var": return (env.get(e.id) ?? 0) !== 0;
    case "call": return callValue(e.call, env) !== 0;
    case "element": return num(e, env) !== 0;
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

type Flow = "next" | "break" | "continue" | "return";

/**
 * Calls as the IR means them (the random programs with functions): every argument worked out, then the parameters
 * set; the body run on the one environment (a function's variables are the program's, one of each); what `return`
 * gives back (0 off the end) into the function's result and the call's own.
 */
const CALLS = { whole: false };
/**
 * What the programs print, as written and as run: each text's bytes (UTF-8, a number in decimal, a byte as itself, a
 * 0 byte as nothing) less 0x0D — which StarCraft draws as nothing, and which a map of our own fills the room around a
 * number with — in hex.
 */
const PRINTED: { want: string[]; got: string[] } = { want: [], got: [] };
const shown = (bytes: number[]) => bytes.filter((b) => b !== 0x0d).map((b) => b.toString(16).padStart(2, "0")).join("");
/**
 * The statements the evaluator may still run for the program in hand (a hundred thousand), its calls' bodies included: a program whose
 * functions call themselves from inside each other's loops can run for hundreds of millions, and is set aside.
 */
const EVAL = { n: Infinity };
const RETURNS: { value: number; kind: string }[] = [];
function callValue(c: Call, env: Env): number {
  const values = c.params.map((p) => (p.decl.kind === "boolean" ? (bool(p.init as BoolExpr, env) ? 1 : 0) : num(p.init as NumExpr, env)));
  // (A call that may come back into the function it is in: that function's variables kept around it.)
  const kept = c.saves?.vars.map((id) => [id, env.get(id) ?? 0] as const);
  c.params.forEach((p, i) => env.set(p.decl.id, values[i]));
  const f = c.fn !== undefined ? FUNCTIONS.get(c.fn) : undefined;
  RETURNS.push({ value: 0, kind: (f ? f.result?.kind : c.result?.kind) ?? "void" });
  run(f ? f.body : c.body, env, EVAL);
  const { value } = RETURNS.pop()!;
  for (const [id, v] of kept ?? []) env.set(id, v);
  if (f?.result) env.set(f.result.decl.id, value);
  if (c.result) env.set(c.result.decl.id, value);
  return value;
}
function run(list: Stmt[], env: Env, budget: { n: number }): Flow {
  for (const s of list) {
    if (--budget.n < 0) throw new Error("too long");
    switch (s.kind) {
      case "declare": env.set(s.decl.id, s.decl.kind === "boolean" ? (bool(s.init as BoolExpr, env) ? 1 : 0) : kept(s.decl.id, num(s.init as NumExpr, env))); break;
      case "assignBool": env.set(s.target, bool(s.value, env) ? 1 : 0); break;
      case "switch": {
        const v = num(s.value, env) | 0;
        let from = s.cases.findIndex((c) => c.value !== null && (c.value | 0) === v);
        if (from < 0) from = s.cases.findIndex((c) => c.value === null);
        if (from < 0) break;
        let out: Flow = "next";
        for (let i = from; i < s.cases.length; i++) {
          const f = run(s.cases[i].body, env, budget);
          if (f === "break") break;
          if (f !== "next") { out = f; break; }
        }
        if (out !== "next") return out;
        break;
      }
      case "unrolled": {
        let out: Flow = "next";
        for (const it of s.iterations) {
          const f = run(it, env, budget);
          if (f === "break") break;
          if (f === "return") { out = f; break; }
        }
        if (out !== "next") return out;
        break;
      }
      case "call": callValue(s.call, env); break;
      case "declareArray": {
        const n = WRITABLE.get(s.array)!;
        const v = (e: NumExpr | BoolExpr) => (["compare", "and", "or", "not", "test"].includes(e.kind) ? (bool(e as BoolExpr, env) ? 1 : 0) : num(e as NumExpr, env));
        const values = s.init?.map(v);
        const fill = s.fill !== undefined ? v(s.fill) : 0;
        for (let i = 0; i < n; i++) env.set(cellKey(s.array, i), kept(s.array, values ? values[i] ?? 0 : fill));
        break;
      }
      case "print": {
        const bytes: number[] = [];
        for (const p of s.parts) {
          if (p.kind === "text") bytes.push(...new TextEncoder().encode(p.text));
          else if (p.kind === "number") bytes.push(...new TextEncoder().encode(p.fixed ? fixedText(num(p.expr, env) | 0) : String(p.unsigned ? num(p.expr, env) : num(p.expr, env) | 0)));
          else if (p.kind === "char") { const b = num(p.expr, env) & 0xff; if (b) bytes.push(b); }
        }
        PRINTED.want.push(shown(bytes));
        break;
      }
      case "return": {
        const r = RETURNS[RETURNS.length - 1];
        r.value = s.value === undefined ? 0 : r.kind === "boolean" ? (bool(s.value as BoolExpr, env) ? 1 : 0) : num(s.value as NumExpr, env);
        return "return";
      }
      case "assign": env.set(s.target, kept(s.target, num(s.value, env))); break;
      case "store": {
        const i = num(s.index, env);
        see(s.index, i);
        const v = ["compare", "and", "or", "not", "test"].includes(s.value.kind) ? (bool(s.value as BoolExpr, env) ? 1 : 0) : num(s.value as NumExpr, env);
        if (i < WRITABLE.get(s.array)!) env.set(cellKey(s.array, i), kept(s.array, v));
        break;
      }
      case "block": { const f = run(s.body, env, budget); if (f !== "next") return f; break; }
      case "if": { const f = run(bool(s.cond, env) ? s.then : s.else ?? [], env, budget); if (f !== "next") return f; break; }
      case "break": return "break";
      case "continue": return "continue";
      case "while": case "for": {
        let out: Flow = "next";
        while (!s.cond || bool(s.cond, env)) {
          const f = run(s.body, env, budget);
          if (f === "break") break;
          if (f === "return") { out = f; break; }
          if (s.kind === "for") run(s.update, env, budget);
        }
        if (out !== "next") return out;
        break;
      }
      case "do": {
        let out: Flow = "next";
        do {
          const f = run(s.body, env, budget);
          if (f === "break") break;
          if (f === "return") { out = f; break; }
        } while (bool(s.cond, env));
        if (out !== "next") return out;
        break;
      }
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
/** The program's `u8` and `u16` variables and arrays, by id: their tops. A store into one is stopped there, read from 0 up. */
const TOPS = new Map<string, number>();
const kept = (id: string, v: number) => (TOPS.has(id) ? Math.min(v >>> 0, TOPS.get(id)!) : v);
/** The variables some array is indexed by (the Python side may keep offsets beside them). */
const INDEXED = new Set<string>();

// ── the graph, as the game runs its triggers ──

/** Where a list's first cell is, as an EPD, and how far apart its cells are, for the interpreter's memory. */
/** The regions of cell triggers of the graph being run (a map of our own's): after the lists in the interpreter's memory. */
const REGIONS: string[] = [];
const TABLE_EPD = (id: string) => 0x100000 * (REGIONS.includes(id) ? 99 + REGIONS.indexOf(id) : 1 + [...TABLES.keys(), ...WRITABLE.keys()].indexOf(id));
/** A writable array's cells in the interpreter's memory: an EUDVArray's, 18 EPD apart. */
const cellEpd = (id: string, i: number) => `epd:${TABLE_EPD(id) + 18 * i}`;
/** Where an array's first cell is as a trigger (an EUDVArray's): a jump into cell i goes to this plus 72 i. */
const ARRAY_ADDR = (id: string) => 0x40000000 + 0x1000000 * (REGIONS.includes(id) ? 99 + REGIONS.indexOf(id) : 1 + [...TABLES.keys(), ...WRITABLE.keys()].indexOf(id));
const numOf = (n: Num): number => (typeof n === "number" ? n : "epdOf" in n ? u(TABLE_EPD(n.epdOf) + n.plus) : u(ARRAY_ADDR(n.addrOf) + n.plus));

function key(d: Dword): string {
  if ("game" in d) return `game:${d.game}`;
  if ("var" in d) return `var:${d.var}`;
  if ("data" in d) return `data:${d.data}`;
  if ("element" in d) throw new Error("an element is read through a condition's player field");
  if ("param" in d) return `param:${d.param.fn}:${d.param.c ?? ""}:${d.index}`;
  if ("counter" in d) return `counter:${d.counter}:${d.part}`;
  if ("getter" in d) return `getter:${d.getter}`;
  // (A scratch cell is the cell of a variable named after it, as the layout has it.)
  if ("temp" in d) return `var:@${d.temp}`;
  if ("template" in d) return `template:${d.template}:${d.word}`;
  if ("cell" in d) return `epd:${TABLE_EPD(d.cell) + 18 * d.index}`;
  const f = d.field;
  return f === "next" || f === "current" ? `${d.at}|${f}` : "cond" in f ? `${d.at}|cond:${f.cond}${f.part === "player" ? ":player" : f.part === "mask" ? ":mask" : ""}` : `${d.at}|act:${f.act}:${f.part}`;
}

function exec(g: Graph, env: Env): Env {
  REGIONS.splice(0, REGIONS.length, ...(g.cells ?? []).map((r) => r.id));
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
  // A map of our own's printed texts' templates, a dword at a time.
  for (const t of g.templates ?? []) for (let w = 0; 4 * w < t.bytes.length; w++) mem.set(key({ template: t.id, word: w }), [0, 1, 2, 3].reduce((x, i) => x + (t.bytes[4 * w + i] ?? 0) * 2 ** (8 * i), 0));
  const showOf = (id: string) => {
    const out: number[] = [];
    for (let w = 0; ; w++) for (let i = 0; i < 4; i++) {
      const b = Math.floor((read(key({ template: id, word: w })) as number) / 2 ** (8 * i)) & 0xff;
      if (b === 0) return shown(out);
      out.push(b);
    }
  };
  // A map of our own's regions of cell triggers (its arrays, its stacks): each cell its number, its action's
  // destination and its next pointer.
  REGIONS.splice(0, REGIONS.length, ...(g.cells ?? []).map((r) => r.id));
  const stacks = (g.cells ?? []).map((r) => ({ epd: TABLE_EPD(r.id), addr: ARRAY_ADDR(r.id), cells: r.cells }));
  for (const [k, st] of stacks.entries()) for (let i = 0; i < st.cells; i++) {
    mem.set(`epd:${st.epd + 18 * i}`, u(g.cells![k].values?.[i] ?? 0));
    for (const d of [-1, -86]) mem.set(`epd:${st.epd + 18 * i + d}`, 0);
  }
  g.triggers.forEach((t, i) => {
    mem.set(`${t.label}|next`, t.next ?? g.triggers[i + 1]?.label ?? END);
    t.conds.forEach((c, k) => {
      mem.set(`${t.label}|cond:${k}`, c.value);
      if (c.mask !== undefined) mem.set(`${t.label}|cond:${k}:mask`, c.mask);
      if ("element" in c.dword) mem.set(`${t.label}|cond:${k}:player`, TABLE_EPD(c.dword.element));
    });
    t.acts.forEach((a, k) => {
      if (a.mask !== undefined) mem.set(`${t.label}|act:${k}:mask`, a.mask);
      mem.set(`${t.label}|act:${k}:value`, typeof a.value === "object" && "label" in a.value ? a.value.label : typeof a.value === "object" && "epd" in a.value ? `@${key(a.value.epd)}` : numOf(a.value));
      // (A store's destination: an EPD its index's writes keep.)
      if ("element" in a.dword) mem.set(`${t.label}|act:${k}:dest`, TABLE_EPD(a.dword.element));
    });
  });
  const read = (k: string) => mem.get(k) ?? 0;
  for (const e of g.entries) mem.set(key(e.into), u(Math.imul(e.scale ?? 1, env.get(e.from) ?? 0) + numOf(e.add)));
  const byLabel = new Map(g.triggers.map((t) => [t.label, t]));
  const keysOf = new Map<Graph["triggers"][number], { conds: { player: string; value: string; at: string }[]; acts: { value: string; dest: string; modifier: string; at: string }[]; next: string }>();
  let pc: string | number = g.triggers[0].label;
  for (let steps = 0; pc !== END; steps++) {
    if (steps > 200_000_000) throw new Error("the graph does not end");
    const st = typeof pc === "number" ? stacks.find((x) => pc as number >= x.addr && (pc as number) < x.addr + 72 * x.cells) : undefined;
    if (st) {
      // A jump into a cell of a stack: its number added where its action points, then on where it points.
      if (((pc as number) - st.addr) % 72) throw new Error(`a jump into a stack between its cells: ${pc}`);
      const i = ((pc as number) - st.addr) / 72, dest = mem.get(`epd:${st.epd + 18 * i - 1}`);
      if (typeof dest !== "string" || !dest.startsWith("@")) throw new Error("a cell of a stack that points nowhere");
      const value = mem.get(`epd:${st.epd + 18 * i}`)!;
      mem.set(dest.slice(1), typeof value === "string" ? value : u(((mem.get(dest.slice(1)) as number) ?? 0) + value));
      pc = mem.get(`epd:${st.epd + 18 * i - 86}`) as string;
      continue;
    }
    if (typeof pc === "number") {
      // A jump into an EUDVArray's cell: it writes its value where eudplib's getter says, and goes where it says.
      const at = pc;
      const id = [...TABLES.keys(), ...WRITABLE.keys()].find((a) => at >= ARRAY_ADDR(a) && at < ARRAY_ADDR(a) + 72 * (TABLES.get(a)?.length ?? WRITABLE.get(a)!));
      if (!id || (at - ARRAY_ADDR(id)) % 72) throw new Error(`a jump outside every array: ${at}`);
      const i = (at - ARRAY_ADDR(id)) / 72;
      const value = TABLES.has(id) ? u(TABLES.get(id)![i]) : (mem.get(cellEpd(id, i)) as number);
      const dest = mem.get("getter:dest");
      if (typeof dest !== "string" || !dest.startsWith("@")) throw new Error("the getter goes nowhere");
      mem.set(dest.slice(1), value);
      pc = mem.get("getter:next") as string;
      continue;
    }
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
    const from = t.copy && `var:${t.copy.from}`;
    // (A label — where a function goes back to — is copied as it is: it is an address only once laid out.)
    for (const c of t.copy?.into ?? []) {
      const x = read(from!);
      mem.set(key(c.dword), typeof x === "string" ? x : u(Math.imul(c.scale ?? 1, x) + numOf(c.add)));
    }
    // (Each field's key worked out once a trigger, not each time it runs.)
    let keys = keysOf.get(t);
    if (!keys) keysOf.set(t, (keys = {
      conds: t.conds.map((c, k) => ({ player: `${t.label}|cond:${k}:player`, value: `${t.label}|cond:${k}`, at: "element" in c.dword ? "" : key(c.dword) })),
      acts: t.acts.map((a, k) => ({ value: `${t.label}|act:${k}:value`, dest: `${t.label}|act:${k}:dest`, modifier: `${t.label}|act:${k}:modifier`, at: "element" in a.dword || a.show !== undefined || a.display !== undefined ? "" : key(a.dword) })),
      next: `${t.label}|next`,
    }));
    const ks = keys;
    // The game stops at the first condition that fails; a masked one compares the dword's bits of the mask with the
    // number as it is.
    const holds = t.conds.every((c, k) => {
      let at: string;
      if ("element" in c.dword) {
        at = `epd:${read(ks.conds[k].player)}`;
        if (!mem.has(at)) throw new Error(`a read outside the list: ${at}`);
      } else at = ks.conds[k].at;
      // (The mask as its field holds it now: a routine may write it.)
      const x = c.mask === undefined ? (read(at) as number) : Number(BigInt(read(at) as number) & BigInt(read(`${t.label}|cond:${k}:mask`) as number)), y = read(ks.conds[k].value) as number;
      return c.compare === "atLeast" ? x >= y : c.compare === "atMost" ? x <= y : x === y;
    });
    if (holds) t.acts.forEach((a, k) => {
      // Set Switch to a random state: the switch's bit where the game keeps it.
      if (a.randomize !== undefined) {
        const at = `game:${SWITCHES + 4 * (a.randomize >> 5)}`, bit = 2 ** (a.randomize & 31), was = (read(at) as number) || 0;
        mem.set(at, randomBit() ? Number((BigInt(was) | BigInt(bit)) & 0xffffffffn) : Number(BigInt(was) & ~BigInt(bit) & 0xffffffffn));
        return;
      }
      // Display Text: what it shows.
      if (a.show !== undefined) { PRINTED.got.push(showOf(a.show)); return; }
      if (a.display !== undefined) { PRINTED.got.push(shown([...new TextEncoder().encode(a.display)])); return; }
      const v = read(ks.acts[k].value);
      // The destination and the modifier as the fields hold them now: a cell routed elsewhere, a store's EPD.
      const dest = mem.get(ks.acts[k].dest);
      const d = typeof dest === "string" && dest.startsWith("@") ? dest.slice(1) : "element" in a.dword ? `epd:${dest}` : ks.acts[k].at;
      if ("element" in a.dword && !mem.has(d)) throw new Error(`a store outside the array: ${d}`);
      if (typeof v === "string") { mem.set(d, v); return; }
      const mf = mem.get(ks.acts[k].modifier);
      const modifier = typeof mf === "number" ? ({ 7: "set", 8: "add", 9: "subtract" } as Record<number, string>)[(mf >>> 24) & 0xff] : a.modifier;
      const old = read(d) as number;
      // (A next pointer moved on by whole triggers goes to the trigger that many after it, as the layout puts them.)
      if (typeof (old as unknown) === "string" && modifier === "add" && v % TRIGGER_BYTES === 0) {
        const i = g.triggers.findIndex((x) => x.label === (old as unknown as string)) + v / TRIGGER_BYTES;
        if (i < 0 || i >= g.triggers.length) throw new Error(`a next pointer moved past the graph: ${old} + ${v}`);
        mem.set(d, g.triggers[i].label);
        return;
      }
      if (a.mask !== undefined) {
        // As the game has a masked write: the dword's bits and the number's under the mask worked, the rest kept — so
        // an addition's carry past the mask is lost.
        const m = read(`${t.label}|act:${k}:mask`) as number, f = Number(BigInt(old) & BigInt(m)), w = Number(BigInt(v) & BigInt(m));
        const next = modifier === "set" ? w : modifier === "add" ? u(f + w) : Math.max(0, f - w);
        mem.set(d, Number((BigInt(old) & ~BigInt(m) & 0xffffffffn) | (BigInt(next) & BigInt(m))));
        return;
      }
      mem.set(d, modifier === "set" ? v : modifier === "add" ? u(old + v) : Math.max(0, old - v));
    });
    pc = read(ks.next) as string | number;
  }
  // (Those offsets still 72 and 18 times their counters.)
  for (const id of INDEXED) {
    const v = (mem.get(`var:${id}`) as number) ?? 0;
    if (mem.get(`counter:${id}:bytes`) !== u(Math.imul(72, v)) || mem.get(`counter:${id}:dwords`) !== u(Math.imul(18, v))) throw new Error(`the offsets beside ${id} are not its`);
  }
  return asEnv();
}

/** The game's random bits for Set Switch to a random state, in the tests: a generator of their own, seeded per test. */
const RANDOM_BITS = { s: 1 };
function randomBit(): number {
  let x = RANDOM_BITS.s >>> 0 || 1;
  x ^= x << 13; x >>>= 0; x ^= x >> 17; x ^= x << 5; x >>>= 0;
  RANDOM_BITS.s = x;
  return x >>> 31;
}

/** A program and its graph, for a look at one seed (EMITTER_SEED): into EMITTER_DUMP's file, or printed. */
function dump(x: unknown): void {
  const text = JSON.stringify(x, null, 1);
  if (process.env.EMITTER_DUMP) writeFileSync(process.env.EMITTER_DUMP, text);
  else console.log(text);
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
  const flags = ["f", "g"].map((name) => { const d = decl(name); d.kind = "boolean"; return d; });
  // Two lists known when the program is built, a short one (the Python side's EUDVArray) and a long one (packed), and
  // a function that is one return of a cell of one.
  TABLES.clear();
  FUNCTIONS.clear();
  WRITABLE.clear();
  TOPS.clear();
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
    if (x < 9) return r.next() < 0.5 ? { kind: "var", id: r.pick(flags).id } : { kind: "not", expr: cond(depth + 1) };
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
      else if (x === 6 && r.next() < 0.5) {
        // A boolean set from a test, a switch (falling through, break and continue in it), a loop the front end unrolled.
        const y = r.next();
        if (y < 0.4) out.push({ kind: "assignBool", target: r.pick(flags).id, value: cond(0), at, label: "" });
        else if (y < 0.75 && depth < 3) {
          const values = [r.pick([0, 1, 2, 3, -1, 7]), r.pick([0, 1, 2, 3, -1, 7]), r.pick([2, 5, 2147483647, -2147483648])];
          const cases = values.map((value) => ({ value, body: [...block(depth + 1, true), ...(r.next() < 0.5 ? [{ kind: "break", at, label: "" } as Stmt] : [])] }));
          if (r.next() < 0.5) cases.push({ value: null as unknown as number, body: block(depth + 1, true) });
          out.push({ kind: "switch", value: r.next() < 0.7 ? v(r.pick(vars)) : bin("+", v(r.pick(vars)), k(1)), cases, at, label: "" } as Stmt);
        } else if (depth < 3) {
          out.push({ kind: "unrolled", iterations: [block(depth + 1, true), block(depth + 1, true)], at, label: "" } as Stmt);
        }
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
  for (const f of flags) env.set(f.id, r.int(2));
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
    if (process.env.EMITTER_LEFT) console.log(taken, stores, emitterCounts, [...left].sort((a, b) => b[1] - a[1]));
    expect(emitterCounts.reciprocals).toBeGreaterThan(200);
    expect(emitterCounts.jumps).toBeGreaterThan(200);
    expect(emitterCounts.hoisted).toBeGreaterThan(200);
    expect(taken).toBeGreaterThan(3900);
    expect(stores).toBeGreaterThan(1000);
  });
});

// ── random programs with functions, as a map of our own lays them out ──

/**
 * A whole program for `emitBody`: its variables declared first, then statements that call functions — as statements,
 * inside sums, in comparisons, in a later part of `&&` / `||`, as arguments of other calls — and inlined calls (a body
 * of their own, as the front end makes a function called once). A function calls only those made before it (nothing
 * calls itself); it reads and writes the program's variables, its parameters and its own, and gives back a number, a
 * boolean or nothing, from inside ifs and loops or off its end.
 */
/** Each index of an array the evaluator reads or stores at: the lowest and highest it was, signed (`observeRanges`). */
const SEEN = new Map<NumExpr, [number, number]>();
/** How many indexes `observeRanges` gave a range. */
const RANGED = { n: 0, arith: 0 };
function see(index: NumExpr, i: number): void {
  const x = i | 0, r = SEEN.get(index);
  SEEN.set(index, r ? [Math.min(r[0], x), Math.max(r[1], x)] : [x, x]);
}

/**
 * Value ranges, as `compiler/ranges.ts` gives them, for a random program: the program is run once, and each index that
 * was inside its array every time it was read or stored at is given the lowest and highest it was — no more than a
 * real range could say. A map of our own tests nothing there, and a store shares its trigger with the writes after it.
 */
function observeRanges(body: Stmt[], arrays: Map<string, ArrayDecl>): void {
  SEEN.clear();
  try {
    run(body, new Map(), { n: 1e5 });
  } catch {
    SEEN.clear();
    return;
  }
  const walk = (x: unknown): void => {
    if (!x || typeof x !== "object") return;
    if (Array.isArray(x)) { x.forEach(walk); return; }
    const o = x as Record<string, unknown>;
    if (o.kind === "element" || o.kind === "store") {
      const index = o.index as NumExpr & { range?: [number, number] }, r = SEEN.get(index), a = arrays.get(o.array as string);
      if (r && a && r[0] >= 0 && r[1] < a.length) { index.range = r; RANGED.n++; }
    }
    // The sides of a product or a quotient (of a reading from 0 up, only a range at or above zero, as ranges.ts gives).
    // (Of a fixed product or quotient, its two arguments and its answer, read as numbers.)
    if (o.kind === "intrinsic" && (o.name === "fmul" || o.name === "fdiv" || o.name === "sqrt" || o.name === "sin" || o.name === "cos" || o.name === "atan2")) {
      for (const side of [...(o.args as NumExpr[]), o as unknown as NumExpr] as (NumExpr & { range?: [number, number] })[]) {
        const r = SEEN.get(side);
        if (r && side.kind !== "const") { side.range = r; RANGED.arith++; }
      }
    }
    if (o.kind === "binary" && (o.op === "*" || o.op === "/" || o.op === "%" || o.op === "&" || o.op === "|" || o.op === "^" || ((o.op === "<<" || o.op === ">>" || o.op === ">>>") && (o.right as NumExpr).kind !== "const"))) {
      // (And the answer's, which a copy of it into a field holding a multiple goes over only the bits of.)
      const r = SEEN.get(o as unknown as NumExpr);
      if (r && (!o.unsigned || r[0] >= 0)) (o as { range?: [number, number] }).range = r;
      for (const side of [o.left, o.right] as (NumExpr & { range?: [number, number] })[]) {
        const r = SEEN.get(side);
        if (r && side.kind !== "const" && (!o.unsigned || r[0] >= 0)) { side.range = r; RANGED.arith++; }
      }
    }
    Object.values(o).forEach(walk);
  };
  walk([body, [...FUNCTIONS.values()].map((f) => f.body)]);
  SEEN.clear();
}

function programWithCalls(seed: number, recursion = false) {
  const r = rng(seed);
  const decls = new Map<string, VarDecl>();
  const decl = (name: string, kind: "number" | "boolean" = "number"): VarDecl => {
    const d: VarDecl = { id: `${name}#${decls.size}`, name, kind, shared: false, at };
    decls.set(d.id, d);
    return d;
  };
  // Parameters and what calls give back are read only inside the call (and a function that is one `return` is put
  // where it is called, setting neither): not compared.
  const inner = new Set<string>();
  const hidden = (d: VarDecl) => (inner.add(d.id), d);
  TABLES.clear();
  FUNCTIONS.clear();
  WRITABLE.clear();
  TOPS.clear();
  type Scope = { nums: VarDecl[]; bools: VarDecl[]; returns?: "number" | "boolean" | "void"; calls: FuncDecl[] };
  const v = (d: VarDecl): NumExpr => ({ kind: "var", id: d.id });
  const k = (n: number): NumExpr => ({ kind: "const", value: n });
  const bin = (op: "+" | "-" | "*" | "<<", left: NumExpr, right: NumExpr): NumExpr => ({ kind: "binary", op, left, right, at, label: "" });
  const globals = ["a", "b", "c", "d"].map((n) => decl(n));
  // (Four at most of the operations that are many triggers each — products, quotients, shifts by a value, square
  // roots, sines — in a program: each kind comes in thousands of programs, and a program of twenty of them takes as
  // long to lay out as a hundred others.)
  let heavy = 4;
  // (Now and then a `u8` or a `u16`, whose stores stop at the top.)
  if (r.next() < 0.3) { const g = globals[3]; g.bits = r.pick([8, 16] as const); TOPS.set(g.id, 2 ** g.bits - 1); }
  const flags = ["f", "g"].map((n) => decl(n, "boolean"));
  let counters = 0;
  // Arrays the program writes (a map of our own keeps them in regions of cell triggers): one of numbers, one of
  // booleans, declared first from a list or one value.
  const arrays = new Map<string, ArrayDecl>();
  const lists = [["N", "number"], ["B", "boolean"]].map(([name, kind]) => {
    const a = { id: `${name}#arr`, name, kind, length: 2 + r.int(7), shared: true, at } as ArrayDecl;
    if (kind === "number" && r.next() < 0.2) { a.bits = r.pick([8, 16] as const); TOPS.set(a.id, 2 ** a.bits - 1); }
    arrays.set(a.id, a);
    WRITABLE.set(a.id, a.length);
    return a;
  });
  const [nums, bools] = lists;
  /** A table of the program's (the sine's, the arc tangent's), added the first time it is read. */
  const table = (id: string, values: () => number[]): string => {
    if (!arrays.has(id)) {
      const v = values();
      arrays.set(id, { id, name: id, kind: "number", length: v.length, shared: true, fixed: true, values: v, at } as ArrayDecl);
      TABLES.set(id, v);
    }
    return id;
  };
  /** An index: inside the array mostly, now and then past its end or below 0. */
  const index = (sc: { nums: VarDecl[] }, a: ArrayDecl): NumExpr => (r.next() < 0.4 ? k(r.next() < 0.85 ? r.int(a.length) : r.pick([a.length, -1, 100])) : r.next() < 0.5 ? v(r.pick(sc.nums)) : bin("+", v(r.pick(sc.nums)), k(r.int(3) - 1)));

  const call = (f: FuncDecl, sc: Scope, depth: number): Call => ({
    name: f.name, fn: f.id, at, label: "", body: [],
    // (A function that calls itself is given a small depth: it goes down to 0 a call at a time.)
    params: f.params.map((p) => ({ decl: p, init: p.kind === "boolean" ? cond(sc, depth + 1) : p.name.startsWith("depth") ? k(r.int(5)) : value(sc, depth + 1), label: "" })),
    ...(f.result ? { result: { decl: hidden(decl(`(${f.name} result)`, f.result.kind === "boolean" ? "boolean" : "number")), kind: f.result.kind } } : {}),
  });
  /** A call of a function used once, its body where it is: a parameter of its own, a return or two. */
  const inlinedCall = (sc: Scope, depth: number, kind: "number" | "boolean" | "void"): Call => {
    const p = hidden(decl("q"));
    const inner: Scope = { nums: [...globals, p], bools: flags, returns: kind, calls: sc.calls };
    const body = block(inner, depth + 2, false);
    if (kind !== "void" && r.next() < 0.7) body.push({ kind: "return", value: kind === "boolean" ? cond(inner, depth + 2) : value(inner, depth + 2), at, label: "" });
    return { name: "once", at, label: "", params: [{ decl: p, init: value(sc, depth + 1), label: "" }], body, ...(kind !== "void" ? { result: { decl: hidden(decl("(once result)", kind === "boolean" ? "boolean" : "number")), kind } } : {}) };
  };
  const callable = (sc: Scope, kind: "number" | "boolean") => sc.calls.filter((f) => (f.result?.kind ?? "void") === kind);

  function value(sc: Scope, depth: number): NumExpr {
    if (r.next() < 0.08) return { kind: "element", array: nums.id, index: index(sc, nums), at };
    // A product or a quotient of numbers with a fraction (16.16), of values and constants, below zero, past 2^31 when wrapped.
    if (r.next() < 0.05 && heavy-- > 0) {
      const side = (): NumExpr => (r.next() < 0.3 ? k(r.pick([65536, 98304, -163840, 1, 0x7fffffff, -2147483648, 3 << 15, 100 << 16, 0])) : depth < 2 && r.next() < 0.2 ? value(sc, depth + 1) : v(r.pick(sc.nums)));
      // (Now and then a square root, of a fixed number or of a whole one read from 0 up; a sine, a cosine or an arc
      // tangent, read from the program's tables.)
      const y = r.next();
      if (y < 0.3) return { kind: "intrinsic", name: "sqrt", args: [side()], ...(y < 0.12 ? { unsigned: true } : {}), at, label: "" };
      if (y < 0.45) return { kind: "intrinsic", name: r.pick(["sin", "cos"] as const), args: [side(), k(SIN_SCALE)], table: table("__sin", sinTable), at, label: "" };
      if (y < 0.6) return { kind: "intrinsic", name: "atan2", args: [side(), side()], table: table("__atan", atanTable), at, label: "" };
      return { kind: "intrinsic", name: r.pick(["fmul", "fdiv"] as const), args: [side(), side()], at, label: "" };
    }
    // A product of two values, a quotient or a remainder (step 4): signed or read from 0 up, by a value or a constant.
    if (r.next() < 0.1 && heavy-- > 0) {
      const op = r.pick(["*", "/", "%", "&", "|", "^", "<<", ">>", ">>>"] as const);
      const side = (): NumExpr => (r.next() < 0.3 ? k(r.pick([...EDGES, 3, 10, 16, -5, 255, 65536, 0xf0f0, -256])) : depth < 2 && r.next() < 0.2 ? value(sc, depth + 1) : v(r.pick(sc.nums)));
      return { kind: "binary", op, left: side(), right: side(), ...((op === "/" || op === "%") && r.next() < 0.35 ? { unsigned: true } : {}), at, label: "" };
    }
    const x = r.int(14);
    const fs = callable(sc, "number");
    if (depth < 3 && x >= 11 && fs.length) return { kind: "call", call: call(r.pick(fs), sc, depth) };
    if (depth < 2 && x === 10 && r.next() < 0.5) return { kind: "call", call: inlinedCall(sc, depth, "number") };
    const any = () => v(r.pick(sc.nums));
    switch (x % 9) {
      case 0: return k(r.pick(EDGES));
      case 1: return any();
      case 2: return bin("+", any(), k(r.pick(EDGES)));
      case 3: return bin("-", any(), depth < 3 ? value(sc, depth + 1) : any());
      case 4: return bin("+", depth < 3 ? value(sc, depth + 1) : any(), any());
      case 5: return { kind: "unary", op: "-", expr: any(), at };
      case 6: return bin("*", any(), k(r.pick([3, -1, 2, 65536])));
      case 7: return depth < 3 ? { kind: "ternary", cond: cond(sc, depth + 1), whenTrue: value(sc, depth + 1), whenFalse: any(), at, label: "" } : any();
      default: {
        const name = r.pick(["min", "max", "abs"] as const);
        const inner = depth < 3 ? value(sc, depth + 1) : any();
        return { kind: "intrinsic", name, args: name === "abs" ? [inner] : [any(), inner], at, label: "" };
      }
    }
  }
  function cond(sc: Scope, depth: number): BoolExpr {
    if (r.next() < 0.06) return { kind: "element", array: bools.id, index: index(sc, bools), at } as BoolExpr;
    const x = r.int(12);
    const fs = callable(sc, "boolean");
    if (depth < 3 && x === 11 && fs.length) return { kind: "call", call: call(r.pick(fs), sc, depth) };
    if (depth < 3 && x >= 8) return { kind: r.next() < 0.5 ? "and" : "or", items: [cond(sc, depth + 1), cond(sc, depth + 1), ...(r.next() < 0.3 ? [cond(sc, depth + 1)] : [])] };
    if (x === 7) return { kind: "var", id: r.pick(sc.bools).id };
    if (x === 6 && depth < 3) return { kind: "not", expr: cond(sc, depth + 1) };
    const sideOf = (): NumExpr => (r.next() < 0.5 ? v(r.pick(sc.nums)) : r.next() < 0.5 ? k(r.pick(EDGES)) : value(sc, depth + 1));
    return { kind: "compare", op: r.pick(["<", "<=", ">", ">=", "==", "!="] as const), left: sideOf(), right: sideOf(), ...(r.next() < 0.7 ? {} : { unsigned: true }), at, label: "" };
  }
  /** A text printed with values in it: words (one not ASCII now and then), numbers signed and not, bytes. */
  const print = (sc: Scope): Stmt => ({
    kind: "print", to: 13, position: "chat", at, label: "",
    parts: Array.from({ length: 1 + r.int(4) }, (): TextPart => {
      const y = r.next();
      if (y < 0.35) return { kind: "text", text: r.pick(["Wave ", " of ", ": ", "x", "é ", "점수 ", ""]) };
      if (y < 0.85) { const z = r.next(); return { kind: "number", expr: value(sc, 1), ...(z < 0.25 ? { unsigned: true } : z < 0.45 ? { fixed: true } : {}) }; }
      return { kind: "char", expr: r.next() < 0.5 ? k(r.int(9)) : v(r.pick(sc.nums)) };
    }),
  });
  function block(sc: Scope, depth: number, inLoop: boolean): Stmt[] {
    const out: Stmt[] = [];
    for (let n = 1 + r.int(4); n > 0; n--) {
      if (r.next() < 0.08) out.push(print(sc));
      if (r.next() < 0.12) {
        const a = r.next() < 0.6 ? nums : bools;
        out.push({ kind: "store", array: a.id, index: index(sc, a), value: a === nums ? value(sc, 1) : cond(sc, 1), at, label: "" });
      }
      const x = r.int(14);
      if (x < 5) out.push({ kind: "assign", target: r.pick(sc.nums).id, value: value(sc, 0), at, label: "" });
      else if (x === 5) out.push({ kind: "assignBool", target: r.pick(sc.bools).id, value: cond(sc, 0), at, label: "" });
      else if (x === 6 && sc.calls.length) out.push({ kind: "call", call: call(r.pick(sc.calls), sc, 0), at, label: "" });
      else if (x === 7 && depth < 3) out.push({ kind: "call", call: inlinedCall(sc, depth, r.pick(["number", "void"] as const)), at, label: "" });
      else if (x < 10 && depth < 3) out.push({ kind: "if", cond: cond(sc, 0), then: block(sc, depth + 1, inLoop), ...(r.next() < 0.5 ? { else: block(sc, depth + 1, inLoop) } : {}), at, label: "" });
      else if (x < 12 && depth < 2) {
        // A loop that ends: a counter of its own, which nothing else writes.
        const c = decl(`i${counters++}`);
        // (Now and then the test calls too, before or after the counter's part.)
        const count: BoolExpr = { kind: "compare", op: "<", left: v(c), right: k(1 + r.int(4)), at, label: "" };
        const y = r.next();
        const test: BoolExpr = y < 0.15 ? { kind: "and", items: [count, cond(sc, 1)] } : y < 0.3 ? { kind: "and", items: [cond(sc, 1), count] } : count;
        const step: Stmt = { kind: "assign", target: c.id, value: bin("+", v(c), k(1)), at, label: "" };
        out.push({ kind: "declare", decl: c, init: k(r.int(2)), at, label: "" });
        const body = block(sc, depth + 1, true);
        const kind = r.int(3);
        out.push(kind === 0 ? { kind: "for", cond: test, update: [step], body, at, label: "" } : kind === 1 ? { kind: "while", cond: test, body: [step, ...body], at, label: "" } : { kind: "do", body: [step, ...body], cond: count, at, label: "", condLabel: "" } as Stmt);
      }
      else if (x === 12 && sc.returns) out.push({ kind: "if", cond: cond(sc, 0), then: [{ kind: "return", ...(sc.returns === "void" ? {} : { value: sc.returns === "boolean" ? cond(sc, 0) : value(sc, 0) }), at, label: "" }], at, label: "" });
      else if (inLoop) out.push({ kind: "if", cond: cond(sc, 0), then: [{ kind: r.next() < 0.5 ? "break" : "continue", at, label: "" }], at, label: "" });
    }
    return out;
  }

  // The functions, each calling only those before it — and, with `recursion`, now and then itself: a depth it is
  // given goes down by one or two a call, and below 1 it returns; each call of itself a statement whose operands are
  // its variables (as the front end makes one), keeping every variable of the function around it (`saves`).
  const made: FuncDecl[] = [];
  for (let i = 0, n = 1 + r.int(4); i < n; i++) {
    const kind = r.pick(["number", "number", "number", "boolean", "void"] as const);
    const recursive = recursion && r.next() < 0.5;
    const first = decls.size;
    const depth = recursive ? hidden(decl(`depth${i}`)) : null;
    const params = [...(depth ? [depth] : []), ...Array.from({ length: r.int(4) }, (_, j) => hidden(decl(`p${i}${j}`, r.next() < 0.2 ? "boolean" : "number")))];
    const locals = Array.from({ length: r.int(3) }, (_, j) => decl(`l${i}${j}`));
    const own = params.filter((p) => p.kind === "number" && p !== depth);
    const sc: Scope = { nums: [...globals, ...own, ...locals], bools: [...flags, ...params.filter((p) => p.kind === "boolean")], returns: kind, calls: [...made] };
    const body: Stmt[] = [
      ...locals.map((l): Stmt => ({ kind: "declare", decl: l, init: value({ ...sc, nums: [...globals, ...own] }, 1), at, label: "" })),
    ];
    const id = `F${i}#f`;
    const saves: { vars: string[]; arrays: string[]; within: string }[] = [];
    if (depth) {
      // Below a depth of 1: some work, and back.
      body.push({ kind: "if", cond: { kind: "compare", op: "<", left: v(depth), right: k(1), at, label: "" }, then: [...block(sc, 2, false), { kind: "return", ...(kind === "void" ? {} : { value: kind === "boolean" ? cond(sc, 0) : value(sc, 0) }), at, label: "" } as Stmt], at, label: "" });
      for (let call = 0, calls = 1 + r.int(2); call < calls; call++) {
        body.push(...block(sc, 1, false));
        const result = kind === "void" ? null : hidden(decl(`(F${i} result)`, kind === "boolean" ? "boolean" : "number"));
        const keep = { vars: [] as string[], arrays: [] as string[], within: `F${i}` };
        saves.push(keep);
        const operand = (): NumExpr => (r.next() < 0.5 ? v(r.pick(sc.nums)) : bin("+", v(r.pick(sc.nums)), k(r.pick(EDGES))));
        body.push({ kind: "call", call: { name: `F${i}`, fn: id, at, label: "", body: [], saves: keep, ...(result ? { result: { decl: result, kind: kind as "number" | "boolean" } } : {}),
          params: params.map((p) => ({ decl: p, label: "", init: p === depth ? bin("-", v(depth), k(1 + r.int(2))) : p.kind === "boolean" ? { kind: "var", id: r.pick(sc.bools).id } as BoolExpr : operand() })) }, at, label: "" });
        if (result && result.kind === "number") sc.nums = [...sc.nums, result];
        if (result && result.kind === "boolean") sc.bools = [...sc.bools, result];
      }
    }
    body.push(...block(sc, 1, false));
    if (kind !== "void" && (depth || r.next() < 0.8)) body.push({ kind: "return", value: kind === "boolean" ? cond(sc, 0) : value(sc, 0), at, label: "" });
    // Every variable of the function — its parameters, its own, those its statements made — but what a call of
    // itself gives back, kept around that call.
    const mine = [...decls.keys()].slice(first);
    for (const keep of saves) {
      const call = body.find((s): s is Extract<Stmt, { kind: "call" }> => s.kind === "call" && s.call.saves === keep);
      keep.vars = mine.filter((x) => x !== call?.call.result?.decl.id);
    }
    // (A function's variables are its own: what one that calls itself leaves in them after it is done is nobody's —
    // a map of our own keeps only what is read again around a call, so the rest is as the deepest call left it.)
    if (depth) for (const x of mine) inner.add(x);
    const f: FuncDecl = { id, name: `F${i}`, params, body, at, ...(depth ? { recursive: true } : {}), ...(kind !== "void" ? { result: { decl: hidden(decl(`(F${i} result)`, kind === "boolean" ? "boolean" : "number")), kind } } : {}) };
    FUNCTIONS.set(f.id, f);
    made.push(f);
  }
  const main: Scope = { nums: globals, bools: flags, calls: made };
  const body: Stmt[] = [
    ...globals.map((d): Stmt => ({ kind: "declare", decl: d, init: k(r.next() < 0.5 ? r.int(20) : r.pick(EDGES)), at, label: "" })),
    ...flags.map((d): Stmt => ({ kind: "declare", decl: d, init: { kind: "const", value: r.next() < 0.5 }, at, label: "" })),
    ...lists.map((a): Stmt => (r.next() < 0.5
      ? { kind: "declareArray", array: a.id, fill: a === nums ? k(r.pick(EDGES)) : { kind: "const", value: r.next() < 0.5 } as BoolExpr, at, label: "" }
      : { kind: "declareArray", array: a.id, init: Array.from({ length: a.length }, () => (a === nums ? k(r.pick(EDGES)) : { kind: "const", value: r.next() < 0.5 } as BoolExpr)), at, label: "" })),
    ...block(main, 0, false),
    ...block(main, 0, false),
  ];
  return { decls, body, inner, arrays };
}

/**
 * How long the random programs of a map of our own may take: 5–50 seconds each alone, longer beside the rest of the
 * suite, which runs its files side by side, and three or four times that on CI's machines — the programs on a stack
 * took 180 seconds there once step 4's numbers came in.
 */
const RANDOM_PROGRAMS = 300_000;

describe("the emitter, calls in a map of our own", () => {
  it("lays out random programs with functions so that they leave every variable as the programs do", () => {
    let taken = 0, texts = 0, numbers = 0;
    const left = new Map<string, number>();
    CALLS.whole = true;
    try {
      for (let seed = 1; seed <= 3000; seed++) {
        const { decls, body, inner, arrays } = programWithCalls(seed);
        // (Every other one with the value ranges a run of it shows.)
        if (seed % 2 === 0) observeRanges(body, arrays);
        const g = emitBody(body, decls, `c${seed}`, FUNCTIONS, arrays);
        if (process.env.EMITTER_SEED === String(seed)) dump({ body, functions: [...FUNCTIONS.values()], g });
        if (typeof g === "string") { left.set(g, (left.get(g) ?? 0) + 1); if (process.env.EMITTER_LEFT === "seeds") console.log(seed, g); continue; }
        taken++;
        const want: Env = new Map();
        EVAL.n = 1e5;
        PRINTED.want = [];
        PRINTED.got = [];
        run(body, want, EVAL);
        let got: Env;
        try { got = exec(g, new Map()); } catch (err) { throw new Error(`seed ${seed}: ${(err as Error).message}`); }
        for (const [id, value] of want) if (!inner.has(id)) expect([seed, id, got.get(id) ?? 0]).toEqual([seed, id, value]);
        expect([seed, PRINTED.got]).toEqual([seed, PRINTED.want]);
        texts += PRINTED.want.length;
        numbers += PRINTED.want.filter((t) => /3[0-9]/.test(t)).length;
      }
    } finally {
      CALLS.whole = false;
    }
    if (process.env.EMITTER_LEFT) console.log(taken, texts, numbers, RANGED.n, RANGED.arith, emitterCounts.products, emitterCounts.quotients, [...left].sort((a, b) => b[1] - a[1]));
    expect(texts).toBeGreaterThan(3000);
    expect(RANGED.n).toBeGreaterThan(1000);
    expect(taken).toBeGreaterThan(2950);
  }, RANDOM_PROGRAMS);
});

describe("the emitter, a loop's test", () => {
  it("tests every turn a part of `&&` that a boolean set in the loop, or a call in it, changes", () => {
    // while (i < 10 && go) { i += 1; go = i < 5; }   and   while (i < 10 && n > 0) { i += 1; shrink(); }
    TABLES.clear();
    WRITABLE.clear();
    TOPS.clear();
    FUNCTIONS.clear();
    const d = (name: string, kind: "number" | "boolean" = "number"): VarDecl => ({ id: `${name}#t`, name, kind, shared: false, at });
    const [i, n, go] = [d("i"), d("n"), d("go", "boolean")];
    const decls = new Map([i, n, go].map((x) => [x.id, x]));
    const v = (x: VarDecl): NumExpr => ({ kind: "var", id: x.id });
    const k = (x: number): NumExpr => ({ kind: "const", value: x });
    const lt = (a: NumExpr, b: NumExpr): BoolExpr => ({ kind: "compare", op: "<", left: a, right: b, at, label: "" });
    const step: Stmt = { kind: "assign", target: i.id, value: { kind: "binary", op: "+", left: v(i), right: k(1), at, label: "" }, at, label: "" };
    const shrink: FuncDecl = { id: "shrink#t", name: "shrink", params: [], body: [{ kind: "assign", target: n.id, value: { kind: "binary", op: "-", left: v(n), right: k(1), at, label: "" }, at, label: "" }], at };
    FUNCTIONS.set(shrink.id, shrink);
    const loops: Stmt[] = [
      { kind: "while", cond: { kind: "and", items: [lt(v(i), k(10)), { kind: "var", id: go.id }] }, body: [step, { kind: "assignBool", target: go.id, value: lt(v(i), k(5)), at, label: "" }], at, label: "" },
      { kind: "while", cond: { kind: "and", items: [lt(v(i), k(10)), lt(k(0), v(n))] }, body: [step, { kind: "call", call: { name: "shrink", fn: shrink.id, params: [], body: [], at, label: "" }, at, label: "" }], at, label: "" },
    ];
    for (const loop of loops) {
      const g = emitLoop(loop, decls, "t", FUNCTIONS);
      expect(typeof g).not.toBe("string");
      const start: Env = new Map([[i.id, 0], [n.id, 3], [go.id, 1]]);
      const want = new Map(start);
      run([loop], want, { n: 1e4 });
      const got = exec(g as Graph, start);
      expect(got.get(i.id)).toBe(want.get(i.id));
    }
  });
});

describe("the emitter, a map of our own's texts", () => {
  it("shows a text for other players than the owner to each in turn: a player, All Players and a force by the map's slots", () => {
    // print("hi", { to: AllPlayers })  and  print("hi", { to: P2 }): Display Text with each player of the group the
    // current player in turn, then the owner again. All Players and a force are the map's human and computer slots.
    const players = { slots: [0, 1, 2], forces: [0, 1, 0, 0, 0, 0, 0, 0] };
    const said = (to: number, map?: typeof players) => emitBody([{ kind: "print", to, position: "chat", parts: [{ kind: "text", text: "hi" }], at, label: "" }], new Map(), "p", undefined, undefined, undefined, 0, map);
    const shown = (to: number, map?: typeof players) => {
      const g = said(to, map);
      if (typeof g === "string") throw new Error(g);
      return g.triggers.flatMap((t) => t.acts).filter((a) => a.display !== undefined).length;
    };
    // (With no map: the eight slots, all in the first force.)
    expect([shown(13), shown(1), shown(17), shown(18), shown(19)]).toEqual([1, 1, 8, 8, 0]);
    expect([shown(17, players), shown(18, players), shown(19, players), shown(20, players)]).toEqual([3, 2, 1, 0]);
    // (Allies, foes: not a group a print goes to — the Python side refuses them too.)
    expect(said(22)).toMatch(/a text shown to a group of players other than P1 to P8, All Players and the forces/);
  });
});

// ── a map of our own, as the game walks its triggers ──

/**
 * A graph laid out as a map of our own (compiler/backend/layout.ts) and its payload run as the game runs triggers, from
 * the bytes: from the trigger that heads the owner's list, each trigger's conditions until one of kind 0 (Deaths, read
 * where its player field says, a mask when 'SC' marks it), its actions until one of kind 0 (Set Deaths: set, add, or
 * subtract stopping at 0; Display Text passed over), then its next pointer — as read after its actions — until one
 * with the top bit set. One pass: the programs sleep nowhere. Returns each variable's cell as the pass left it.
 */
const laidOut = new WeakMap<Graph, { arrays: Map<string, number[]>; own: ReturnType<typeof layout>; texts: string[]; templates: string[] }>();
/** `memory`: dwords of the game's as the map starts, by address (a player's name, their colour); `arrays`: the lists the graph reads. */
/** `runs`: instead of `g` alone, several runs laid out one after another, as a map of our own runs them each frame. */
function runOwn(g: Graph, memory?: Map<number, number>, arrays = new Map<string, number[]>(), runs?: { graph: Graph; owner: number }[]): Env {
  // (Laid out once a graph: a test may walk one many times.)
  let done = laidOut.get(g);
  if (!done || (done.arrays !== arrays && (done.arrays.size || arrays.size))) {
    // (Strings by number: a printed text's template 1000 on, a text known when built 5000 on.)
    const templates = (runs ? runs.flatMap((r) => r.graph.templates ?? []) : g.templates ?? []).map((t) => t.id), texts: string[] = [];
    // (Every dword no trigger or data holds all ones: nothing reads them.)
    const own = layout({ ...(runs ? { runs } : { graph: g, owner: 0 }), strings: 0, text: (t) => 5000 + (texts.includes(t) ? texts.indexOf(t) : texts.push(t) - 1), arrays, template: (id) => 1000 + templates.indexOf(id), free: 0xffffffff });
    done = { arrays, own, texts, templates };
    laidOut.set(g, done);
  }
  const { own, texts, templates } = done;
  const DEATHS = 0x58a364;
  const bytes = own.payload.slice();
  const dv = new DataView(bytes.buffer);
  // (The payload follows strings of no length: no padding before its first trigger.)
  const base = own.address;
  const inside = (a: number) => a >= base && a + 4 <= base + bytes.length;
  const game = new Map<number, number>(memory);
  const rd = (a: number) => (inside(a) ? dv.getUint32(a - base, true) : game.get(a) ?? 0);
  const wr = (a: number, v: number) => (inside(a) ? dv.setUint32(a - base, u(v), true) : game.set(a, u(v)));
  const byte = (a: number) => dv.getUint8(a - base);
  // (A player field of 13 is the current player: the dword whose EPD the game's current player is.)
  const at = (epd: number) => u(DEATHS + 4 * (epd === 13 ? rd(0x6509b0) : epd));
  let pc = own.address;
  for (let steps = 0; !(pc & 0x80000000); steps++) {
    if (steps > 200_000_000) throw new Error("the payload does not end");
    if (!inside(pc)) throw new Error(`the walk left the payload: 0x${pc.toString(16)}`);
    let holds = (rd(pc + 2376) & 8) === 0;
    for (let k = 0; holds && k < 16; k++) {
      const o = pc + 8 + 20 * k, kind = byte(o + 15);
      // (As the game: one switched off is passed over before the kind is asked.)
      if (byte(o + 17) & 2) continue;
      if (kind === 0) break;
      if (kind !== 15) throw new Error(`condition kind ${kind}`);
      const masked = dv.getUint16(o + 18 - base, true) === 0x4353;
      const x = masked ? (rd(at(rd(o + 4))) & rd(o)) >>> 0 : rd(at(rd(o + 4))), y = rd(o + 8), compare = byte(o + 14);
      holds = compare === 0 ? x >= y : compare === 1 ? x <= y : x === y;
    }
    for (let k = 0; holds && k < 64; k++) {
      const o = pc + 328 + 32 * k, kind = byte(o + 26);
      if (byte(o + 28) & 2) continue;
      if (kind === 0) break;
      if (kind === 9) {
        // Display Text: the string's bytes as they are now, to the first 0.
        const index = rd(o + 4);
        if (index >= 5000) { PRINTED.got.push(shown([...new TextEncoder().encode(texts[index - 5000])])); continue; }
        const out: number[] = [];
        for (let a = own.templates.get(templates[index - 1000])!; byte(a) !== 0; a++) out.push(byte(a));
        PRINTED.got.push(shown(out));
        continue;
      }
      if (kind === 13) {
        // Set Switch: to a random state (11), its bit where the game keeps it.
        const sw = rd(o + 20), addr = SWITCHES + 4 * (sw >> 5), bit = 2 ** (sw & 31);
        if (byte(o + 27) !== 11) throw new Error(`Set Switch ${byte(o + 27)}`);
        wr(addr, randomBit() ? (rd(addr) | bit) >>> 0 : (rd(addr) & ~bit) >>> 0);
        continue;
      }
      if (kind !== 45) throw new Error(`action kind ${kind}`);
      const dest = at(rd(o + 16)), value = rd(o + 20), modifier = byte(o + 27), old = rd(dest);
      if (dv.getUint16(o + 30 - base, true) === 0x4353) {
        // (A masked write as the game has it: the bits under the mask of both worked, a carry past them lost.)
        const m = rd(o), f = (old & m) >>> 0, w = (value & m) >>> 0;
        const next = modifier === 7 ? w : modifier === 8 ? u(f + w) : Math.max(0, f - w);
        wr(dest, ((old & ~m) | (next & m)) >>> 0);
        continue;
      }
      wr(dest, modifier === 7 ? value : modifier === 8 ? u(old + value) : Math.max(0, old - value));
    }
    pc = rd(pc + 4);
  }
  const out: Env = new Map([...own.vars].map(([id, a]) => [id, rd(a)]));
  for (const [id, n] of WRITABLE) {
    const r = own.regions.get(id);
    if (r !== undefined) for (let i = 0; i < n; i++) out.set(cellKey(id, i), rd(r + 72 * i + 348));
  }
  return out;
}

describe("a map of our own, laid out", () => {
  it("runs random programs with functions as their graphs do, from the payload's bytes", () => {
    CALLS.whole = true;
    let ran = 0;
    try {
      for (let seed = 1; seed <= 3000; seed += 7) {
        const { decls, body, inner, arrays } = programWithCalls(seed);
        if (seed % 2 === 0) observeRanges(body, arrays);
        const g = emitBody(body, decls, `c${seed}`, FUNCTIONS, arrays);
        if (typeof g === "string") continue;
        const want: Env = new Map();
        EVAL.n = 1e5;
        PRINTED.want = [];
        PRINTED.got = [];
        run(body, want, EVAL);
        let got: Env;
        try { got = runOwn(g); } catch (err) { throw new Error(`seed ${seed}: ${(err as Error).message}`); }
        for (const [id, value] of want) if (!inner.has(id)) expect([seed, id, got.get(id) ?? 0]).toEqual([seed, id, value]);
        expect([seed, PRINTED.got]).toEqual([seed, PRINTED.want]);
        ran++;
      }
    } finally {
      CALLS.whole = false;
    }
    expect(ran).toBeGreaterThan(400);
  }, RANDOM_PROGRAMS);
});

describe("a map of our own, its first statement", () => {
  it("goes where a program's first statement sends it: a boolean declared false is false", () => {
    // (`let done = false` first: the jump past the true side is the graph's first trigger, empty but for its next
    // pointer, and is kept — dropped, the walk came in at the true side.)
    const decl: VarDecl = { id: "done", name: "done", kind: "boolean", shared: false, at };
    const body = [
      { kind: "declare", decl, init: { kind: "const", value: false }, at },
      { kind: "if", cond: { kind: "not", expr: { kind: "var", id: "done" } }, then: [{ kind: "print", to: 13, position: "chat", parts: [{ kind: "text", text: "not done" }], at, label: "" }], at },
      { kind: "assignBool", target: "done", value: { kind: "const", value: true }, at },
    ] as Stmt[];
    const g = emitBody(body, new Map([["done", decl]]), "b", undefined, undefined, undefined, 0);
    if (typeof g === "string") throw new Error(g);
    PRINTED.got = [];
    const got = runOwn(g);
    expect([PRINTED.got, got.get("done")]).toEqual([[shown([...new TextEncoder().encode("not done")])], 1]);
  });
});

describe("a map of our own, memory at a value's address", () => {
  it("writes a dword at a value's EPD, reads it back whole and as a byte, and compares it in one condition", () => {
    const decl = (id: string): VarDecl => ({ id, name: id, kind: "number", shared: false, at });
    const v = (id: string): NumExpr => ({ kind: "var", id });
    const c = (value: number): NumExpr => ({ kind: "const", value });
    const deaths = (mask?: number): ConditionRecord => ({ location: mask ?? 0, player: 0, amount: 0, unitId: 0, comparison: 0, type: 15, resource: 0, flags: 0, mask: mask === undefined ? 0 : 0x4353 });
    const set = { location: 0, text: 0, wav: 0, time: 0, player: 0, target: 0, unitId: 0, type: 45, modifier: 7, flags: 0, padding: 0, mask: 0 };
    const read = (mask?: number): NumExpr => ({ kind: "read", read: { source: "condition", record: deaths(mask), epd: v("e") }, at, label: "" } as NumExpr);
    const body = [
      { kind: "declare", decl: decl("e"), init: c(1000), at },
      { kind: "assign", target: "e", value: { kind: "binary", op: "+", left: v("e"), right: c(5), at, label: "" }, at },
      { kind: "action", record: set, variables: [{ field: "player", bits: 32, name: "at", expr: v("e") }, { field: "target", bits: 32, name: "n", expr: c(0x12345678) }], at, label: "" },
      { kind: "declare", decl: decl("x"), init: read(), at },
      { kind: "declare", decl: decl("b"), init: { kind: "binary", op: ">>>", left: read(0xff0000), right: c(16), at, label: "" }, at },
      { kind: "declare", decl: decl("same"), init: c(0), at },
      { kind: "if", cond: { kind: "compare", op: "==", left: read(), right: c(0x12345678), at, label: "" }, then: [{ kind: "assign", target: "same", value: c(1), at }], at },
    ] as Stmt[];
    const decls = new Map(["e", "x", "b", "same"].map((id) => [id, decl(id)]));
    const g = emitBody(body, decls, "m", undefined, undefined, undefined, 0);
    if (typeof g === "string") throw new Error(g);
    const got = runOwn(g);
    expect([got.get("x"), got.get("b"), got.get("same")]).toEqual([0x12345678, 0x34, 1]);
    // (The comparison is one condition: no trigger reads the dword a bit at a time for it.)
    expect(g.triggers.filter((t) => t.conds.some((k) => k.game?.comparison === 10)).length).toBe(1);
    // (The byte read moves its bits down as it reads them: no shift after it.)
    expect(g.triggers.filter((t) => t.conds.some((k) => k.compare === "exactly")).length).toBe(0);
  });
});

describe("a map of our own, texts made while the game runs", () => {
  /** What a one-program script prints, its payload walked from its bytes (one pass: it sleeps nowhere). */
  const printed = (body: string, file = "main.ts", memory?: Map<number, number>): string[] => {
    const r = compileScript(ts, { [file]: `program(() => {\n  let n = 0;\n  while (n < 12) n += 5;\n${body}\n});\n` }, defaultScriptNames(), { lib: defaultLib(), emitter: false });
    expect(r.diagnostics).toEqual([]);
    const o = emitOwn(r);
    if (typeof o === "string") throw new Error(o);
    PRINTED.got = [];
    runOwn(o.runs[0].graph, memory, o.values);
    return PRINTED.got;
  };
  const bytes = (...lines: string[]) => lines.map((l) => shown([...new TextEncoder().encode(l)]));

  it("makes a text of a number, a known text and another made text, and shows a made one as it is", () => {
    expect(printed(`  const a = String(n);\n  print(a);\n  print(\`[\${a}] \${a.padStart(4, "0")} \${"ab".repeat(n / 5)}\`);`)).toEqual(bytes("15", "[15] 0015 ababab"));
  });

  it("copies a made text to every byte a cursor can be at, and cuts nothing short", () => {
    // (Each piece longer than the last and each at another byte of a dword: the copies split across dwords.)
    let want = "", s = "x";
    for (let i = 0; i < 7; i++) { want = want + s + String(i); s = s + "yz"; }
    expect(printed(`  let s = "x";\n  let t = "";\n  let i = 0;\n  while (i < 7) {\n    t = t + s + String(i);\n    s = s + "yz";\n    i += 1;\n  }\n  print(t);`)).toEqual(bytes(want));
  });

  it("reads a made text's characters, searches it, and orders it against others", () => {
    const got = printed(`  const t = \`  \${n} ore, \${n * 2} gas  \`.trim();\n  print(\`\${t.length} \${t.charCodeAt(1)} \${t.indexOf("gas")} \${t.includes("ore")} \${t.startsWith("15")} \${t.endsWith("gas")} \${t < "16"} \${t > "15"} \${t.slice(4, 7)}\`);`);
    const t = "15 ore, 30 gas";
    expect(got).toEqual(bytes(`${t.length} ${t.charCodeAt(1)} ${t.indexOf("gas")} true true true true true ${t.slice(4, 7)}`));
  });

  it("puts JSX together a piece at a time, a colour chosen by a value among it", () => {
    expect(printed(`  const c = n > 10 ? textColors.green : textColors.red;\n  print(<line>Wave {n} <cell color={c} /></line>);`, "main.tsx")).toEqual(bytes("\x04Wave 15 \x07■"));
  });

  it("prints a player's name and colour from where the game keeps them", () => {
    // (Player 2: "Raynor" 11 bytes into their 36 at 0x57EEE0; the first shade of their colour, red's, 8 bytes a player
    // at 0x581D76 — the code nearest it 8.)
    const memory = new Map<number, number>();
    const poke = (addr: number, byte: number) => memory.set(addr & ~3, ((memory.get(addr & ~3) ?? 0) + byte * 2 ** (8 * (addr & 3))) >>> 0);
    [...new TextEncoder().encode("Raynor"), 0].forEach((b, j) => poke(0x57eeeb + 36 + j, b));
    poke(0x581d76 + 8, 0x6f);
    expect(printed("  print(`${name(P2)} ${color(P2)}joined, ${name(P2)}${name(P2)}`);", "main.ts", memory)).toEqual(bytes("Raynor \x08joined, RaynorRaynor"));
  });

  it("keeps a player's colour and name in a text and looks into them, as the game filled them in", () => {
    // (Player 1: "Raynor"; red, the code nearest it 8. The colour one character of the text, the name six.)
    const memory = new Map<number, number>();
    const poke = (addr: number, byte: number) => memory.set(addr & ~3, ((memory.get(addr & ~3) ?? 0) + byte * 2 ** (8 * (addr & 3))) >>> 0);
    [...new TextEncoder().encode("Raynor"), 0].forEach((b, j) => poke(0x57eeeb + j, b));
    poke(0x581d76, 0x6f);
    expect(printed("  const c = `${color(P1)}`;\n  const who = `${name(P1)}!`;\n  print(`${c.length} ${c.charCodeAt(0)} ${who.length} ${who === \"Raynor!\"}`);", "main.ts", memory)).toEqual(bytes("1 8 7 true"));
  });

  it("joins, measures and searches an array written where it is used", () => {
    expect(printed("  print([n, 2, 8].join(\", \"));\n  print(`${[1, n].length} ${[n, 4].indexOf(4)} ${[n, 4].includes(15)} ${[n, 7].map((x) => x * 2).join(\"+\")} ${Math.max(...[n, 4])}`);")).toEqual(bytes("15, 2, 8", "2 1 true 30+14 15"));
  });

  it("keeps an array of texts and a text in each row of records, written at a place that changes", () => {
    const got = printed([
      `  const names = ["Marine", "Marine", "Marine"];`,
      `  let i = 0;`,
      `  while (i < 2) i += 1;`,
      `  names[i] = "Medic";`,
      `  names[0] = \`\${names[i]} x\${n}\`;`,
      // (Past the array's end: nothing written, as a number's array.)
      `  names[i + 3] = "none";`,
      `  print(names.join(", "));`,
      `  const heroes = [{ name: "Raynor", hp: 5 }, { name: "Kerrigan", hp: 7 }];`,
      `  heroes[i - 1].name = heroes[0].name + "!";`,
      `  print(\`\${heroes[1].name} \${heroes[0].name.length} \${names[1] === "Marine"}\`);`,
    ].join("\n"));
    expect(got).toEqual(bytes("Medic x15, Marine, Medic", "Raynor! 6 true"));
  });
});

describe("a map of our own, arrays that grow", () => {
  /**
   * What a script prints as the simulator runs it and as its payload does, walked from its bytes (one pass: it sleeps
   * nowhere), every program's run laid out — and what the payload said that the simulator keeps as a fault, apart.
   */
  const both = (source: string, file = "main.ts"): { want: string[]; got: string[]; said: string[]; bytes: number } => {
    const r = compileScript(ts, { [file]: source }, defaultScriptNames(), { lib: defaultLib(), emitter: false });
    expect(r.diagnostics).toEqual([]);
    const hex = (text: string) => shown([...new TextEncoder().encode(text)]);
    const want = simulatePrograms(r.ir, 1, { strings: r.strings }).events.filter((e) => e.text !== undefined).map((e) => hex(e.text!));
    const o = emitOwn(r);
    if (typeof o === "string") throw new Error(o);
    PRINTED.got = [];
    const runs = o.runs.map((run) => ({ graph: run.graph, owner: run.player }));
    runOwn(runs[0].graph, undefined, o.values, runs.length > 1 ? runs : undefined);
    const oom = hex("\x06TrigScript: out of memory");
    const said = PRINTED.got.filter((l) => l.startsWith(oom));
    const bytes = layout({ runs, strings: 0, text: () => 1, arrays: o.values, template: () => 1 }).payload.length;
    return { want, got: PRINTED.got.filter((l) => !l.startsWith(oom)), said, bytes };
  };
  const same = (body: string, file = "main.ts") => {
    const r = both(body, file);
    expect(r.want.length).toBeGreaterThan(0);
    expect(r.got).toEqual(r.want);
    expect(r.said).toEqual([]);
  };

  it("pushes past several blocks, pops, cuts short, stores at the end and past it", () => {
    same(`program(() => {
  const xs: number[] = [];
  let i = 0;
  while (i < 40) { xs.push(i * 3); i++; }
  let sum = 0;
  for (const x of xs) sum += x;
  const last = xs.pop()!;
  xs.pop();
  xs.length = 30;
  let at = 30;
  xs[at] = 7;
  at = 40;
  xs[at] = 9;
  let below = -1;
  xs[below] = 9;
  const ys = [5, 6];
  const a = ys.pop() ?? 0, b = ys.pop() ?? 0, c = ys.pop() ?? -1;
  print(\`\${xs.length} \${sum} \${last} \${xs[30]} \${xs[at]} \${xs[below]} \${xs[29]} \${a} \${b} \${c} \${ys.length}\`);
});`);
  });

  it("gives a block back when an array is declared again, so a loop of them never runs the heap out", () => {
    // (500 arrays of 32 cells would be 16 000 cells, near the heap's whole 16 384, were none given back.)
    same(`program(() => {
  let turns = 0, seen = 0;
  while (turns < 500) {
    const fresh: number[] = [];
    let j = 0;
    while (j < 20) { fresh.push(turns + j); j++; }
    seen += fresh[19];
    turns++;
  }
  print(\`\${seen}\`);
});`);
  });

  it("keeps booleans and u8 cells as the simulator does, and a Map, a Set and the copies the library makes", () => {
    same(`program(() => {
  const flags: boolean[] = [];
  let f = 0;
  while (f < 10) { flags.push(f % 3 == 0); f++; }
  let set = 0;
  for (const b of flags) if (b) set++;
  const bytes: u8[] = [];
  let over = 300, under = -4;
  bytes.push(over);
  bytes.push(under);
  let k = 1;
  const scores = new Map<number, number>();
  let key = 3;
  while (key < 3000) { scores.set(key, key * 2); key = key * 3; }
  scores.delete(27);
  const seenSet = new Set<number>();
  let s = 0;
  while (s < 30) { seenSet.add(s % 7); s++; }
  const hs = [5, 1, 4, 2, 3];
  const big = hs.filter((x) => x > 2).concat(hs.map((x) => x * 2)).slice(1, 4);
  const sorted = hs.toSorted((a, b) => a - b).toReversed();
  hs.splice(1, 2, 9);
  print(\`\${set} \${flags[k + 2]} \${flags[k]} \${bytes[0]} \${bytes[1]} \${scores.size} \${scores.get(81) ?? 0} \${seenSet.size} \${big[2]} \${sorted[0]} \${hs[1]} \${hs.length}\`);
});`);
  });

  it("keeps rows that grow inside an array that grows, numbers and booleans", () => {
    same(`program(() => {
  const rows: number[][] = [];
  let i = 0;
  while (i < 5) { rows.push([]); i++; }
  i = 0;
  while (i < 40) { rows[i % 5].push(i); i++; }
  rows[2][3] = 99;
  rows[4].length = 2;
  const last = rows[3].pop()!;
  rows.push([7, 8, 9]);
  let sum = 0;
  for (const r of rows) for (const v of r) sum += v;
  const flags: boolean[][] = [[true], [false, true]];
  flags[0].push(false);
  print(\`\${rows.length} \${rows[0].length} \${rows[2][3]} \${rows[4].length} \${last} \${rows[5][1]} \${sum} \${flags[0].length} \${flags[1][1]} \${flags[0][1]}\`);
});`);
  });

  it("keeps arrays of texts that grow, each cell's text a block of the pool's, given back when it goes", () => {
    same(`program(() => {
  const log: string[] = [];
  let n = 0;
  while (n < 6) { log.push(\`line \${n}\`); n++; }
  log[2] = log[2] + "!";
  log[0] = "first";
  const gone = log.pop()!;
  log.shift();
  log.splice(1, 1, "mid", \`n=\${n}\`);
  print(log.join(", "));
  print(log[1]);
  print(\`\${log.length} \${gone} \${log.includes("mid")} \${log.indexOf("line 4")}\`);
  let turns = 0, total = 0;
  while (turns < 100) {
    const words: string[] = [];
    let w = 0;
    while (w < 3) { words.push(\`w\${turns}.\${w}\`); w++; }
    total += words[2].length;
    turns++;
  }
  const parts = "a,bb,ccc".split(",");
  print(\`\${total} \${parts.length} \${parts[2]} \${parts.join("+")}\`);
});`);
  });

  it("keeps a closure's variables, and an array in a function that calls itself on its stack", () => {
    same(`function counter() { let n = 0; return () => { n += 1; return n; }; }
function build(n: number): number {
  const xs: number[] = [];
  let i = 0;
  while (i < n) { xs.push(i * n); i++; }
  let s = 0;
  if (n > 1) s = build(n - 1) + build(n - 2);
  for (const v of xs) s += v;
  return s + xs.length;
}
program(() => {
  const next = counter();
  let t = 0, c = 0;
  while (t < 3) { c += next(); t++; }
  let n = 0;
  while (n < 6) n += 1;
  let total = 0, turns = 0;
  while (turns < 30) { total += build(n); turns++; }
  print(\`\${c} \${build(n)} \${total}\`);
});`);
  });

  it("reads and stores at a loop's counter untested: over an array, over records, and another array shorter than it", () => {
    same(`program(() => {
  const xs: number[] = [];
  let m = 0;
  while (m < 30) { xs.push(m); m++; }
  let total = 0;
  for (let i = 0; i < xs.length; i++) total += xs[i];
  for (const v of xs) total += v * 2;
  for (let i = 0; i < xs.length; i++) xs[i] = xs[i] + 1;
  // (Records: each field an array of its own, as long as the first.)
  const bs: { x: number; dx: number; life: number }[] = [];
  let b = 0;
  while (b < 12) { bs.push({ x: b * 13, dx: 3 + b % 5, life: b % 4 }); b++; }
  let alive = 0;
  for (const q of bs) { q.x += q.dx; if (q.x >= 100) q.dx = -3; if (q.life > 0) { q.life--; alive++; } }
  // (Another array at the counter, shorter: read past its end 0, a store at its length a push, past it nothing.)
  const short = [7];
  short.push(8);
  let seen = 0, two = 2;
  for (let i = 0; i < xs.length; i++) { seen += short[i]; if (i < 4) short[i] = i * 10; if (i > 6) break; }
  // (A counter read after the loop, a step of two, a continue.)
  let j = 0, odd = 0;
  for (j = 1; j < xs.length; j += 2) { if (xs[j] % 3 == 0) continue; odd += xs[j]; }
  print(\`\${total} \${xs[29]} \${alive} \${bs[11].x} \${bs[11].dx} \${bs[3].life} \${seen} \${short.length} \${short[two]} \${j} \${odd}\`);
});`);
  });

  it("works a remainder by a constant into the counter it keeps, read and stored at", () => {
    same(`program(() => {
  const xs: number[] = [];
  let m = 0;
  while (m < 50) { xs.push(m * 3); m++; }
  let k = 0, total = 0, n = 0, j = 7, odd = 0;
  while (n < 200) { total += xs[k]; xs[k] = xs[k] + 1; k = (k + 13) % 50; j = (j + 3) % 4; odd += j; n++; }
  print(\`\${total} \${k} \${xs[13]} \${j} \${odd}\`);
});`);
  });

  it("moves cells along arrays of numbers and of texts for shift, unshift and splice, both ways", () => {
    same(`program(() => {
  const xs: number[] = [];
  let m = 0;
  while (m < 12) { xs.push(m); m++; }
  xs.shift();
  xs.unshift(-1, -2);
  xs.splice(3, 2);
  xs.splice(1, 0, 70, 71, 72);
  const flags: boolean[] = [true, false, true];
  flags.splice(1, 1);
  flags.unshift(false);
  const log: string[] = [];
  while (m < 18) { log.push(\`l\${m}\`); m++; }
  log.shift();
  log.splice(1, 1, "a", "b", "c");
  log.unshift("first");
  print(\`\${xs.join(",")} \${xs.length} \${flags.join(",")} \${log.join(",")}\`);
});`);
  });

  it("runs out where the simulator does, the heap one for every program, and says so once", () => {
    const r = both(["A", "B", "C"].map((name, k) => `program(() => {
  const a: number[] = [];
  let i = 0;
  while (i < ${[5000, 5000, 3000][k]}) { a.push(i * ${k + 1}); i++; }
  print(\`${name} \${a.length} \${a[a.length - 1]}\`);
});`).join("\n"));
    expect(r.want).toHaveLength(3);
    expect(r.got).toEqual(r.want);
    expect(r.said.length).toBe(1);
    // (One heap for the three runs: its 16 384 cells, 72 bytes each, laid out once.)
    expect(r.bytes).toBeLessThan(2 * 16384 * 72);
  });
});

describe("a map of our own, random numbers", () => {
  it("draws each whole number below the bound as often as the next, from the game's own random bits", () => {
    // x = random(n) for bounds known and not, small and large; run many times, as a graph and from the laid-out bytes.
    const decls = new Map<string, VarDecl>();
    const decl = (name: string): VarDecl => { const d: VarDecl = { id: `${name}#${decls.size}`, name, kind: "number", shared: false, at }; decls.set(d.id, d); return d; };
    const [x, n] = [decl("x"), decl("n")];
    const v = (d: VarDecl): NumExpr => ({ kind: "var", id: d.id });
    const draw = (bound: NumExpr, range?: [number, number]): Stmt[] => [{ kind: "declare", decl: x, init: { kind: "randomInt", bound: range ? ({ ...bound, range } as unknown as NumExpr) : bound, at, label: "" }, at, label: "" } as Stmt];
    const cases: { name: string; body: Stmt[]; bound: number }[] = [
      ...[2, 6, 7, 8, 100].map((b) => ({ name: `random(${b})`, body: draw({ kind: "const", value: b }), bound: b })),
      ...[1, 3, 6, 33].map((b) => ({ name: `random(n), n ${b}`, body: [{ kind: "declare", decl: n, init: { kind: "const", value: b }, at, label: "" } as Stmt, ...draw(v(n))], bound: b })),
      { name: "random(n), n in 0 … 40", body: [{ kind: "declare", decl: n, init: { kind: "const", value: 12 }, at, label: "" } as Stmt, ...draw(v(n), [0, 40])], bound: 12 },
    ];
    for (const c of cases) {
      const g = emitBody(c.body, decls, "rnd", new Map(), new Map());
      expect([c.name, typeof g === "string" ? g : "takes"]).toEqual([c.name, "takes"]);
      if (typeof g === "string") continue;
      const counts = Array(c.bound).fill(0);
      const runs = 400 * c.bound;
      RANDOM_BITS.s = 12345;
      for (let i = 0; i < runs; i++) {
        const got = i % 3 ? exec(g, new Map()) : runOwn(g);
        const value = got.get(x.id) ?? 0;
        expect([c.name, value < c.bound]).toEqual([c.name, true]);
        counts[value]++;
      }
      // Each value within a fifth of its share.
      for (const k of counts) expect([c.name, Math.abs(k - runs / c.bound) < runs / c.bound / 5]).toEqual([c.name, true]);
    }
  });
});

describe("a map of our own, functions that call themselves", () => {
  it("keeps their frames on a stack of its own: random programs as written, as graphs and from the payload's bytes", () => {
    CALLS.whole = true;
    let taken = 0, deep = 0, long = 0;
    const left = new Map<string, number>();
    try {
      // (EMITTER_SEEDS runs more of them, for a longer look; EMITTER_FROM starts further on.)
      for (let seed = Number(process.env.EMITTER_FROM ?? 1); seed <= Number(process.env.EMITTER_SEEDS ?? 1500); seed++) {
        const { decls, body, inner, arrays } = programWithCalls(seed, true);
        if (seed % 2 === 0) observeRanges(body, arrays);
        // (64 calls deep: these go a few levels, and a stack of 1024 frames a function is most of what the interpreters
        // would spend their time setting up.)
        const g = emitBody(body, decls, `r${seed}`, FUNCTIONS, arrays, 64);
        if (process.env.EMITTER_SEED === String(seed)) dump({ body, functions: [...FUNCTIONS.values()], g });
        if (typeof g === "string") { left.set(g, (left.get(g) ?? 0) + 1); continue; }
        taken++;
        if (g.cells?.some((r) => r.id.startsWith("@stack"))) deep++;
        const want: Env = new Map();
        EVAL.n = 1e5;
        PRINTED.want = [];
        PRINTED.got = [];
        try {
          run(body, want, EVAL);
        } catch (err) {
          if ((err as Error).message !== "too long") throw err;
          long++;
          continue;
        }
        let got: Env;
        try { got = exec(g, new Map()); } catch (err) { throw new Error(`seed ${seed}: ${(err as Error).message}`); }
        for (const [id, value] of want) if (!inner.has(id)) expect([seed, id, got.get(id) ?? 0]).toEqual([seed, id, value]);
        expect([seed, PRINTED.got]).toEqual([seed, PRINTED.want]);
        if (seed % 5 === 0) {
          PRINTED.got = [];
          try { got = runOwn(g); } catch (err) { throw new Error(`seed ${seed}, laid out: ${(err as Error).message}`); }
          for (const [id, value] of want) if (!inner.has(id)) expect([seed, "laid out", id, got.get(id) ?? 0]).toEqual([seed, "laid out", id, value]);
          expect([seed, "laid out", PRINTED.got]).toEqual([seed, "laid out", PRINTED.want]);
        }
      }
    } finally {
      CALLS.whole = false;
    }
    if (process.env.EMITTER_LEFT) console.log(taken, deep, long, [...left].sort((a, b) => b[1] - a[1]));
    // (Set aside as too long to run here: rare, a few in a hundred at most.)
    expect(long).toBeLessThan(0.02 * (Number(process.env.EMITTER_SEEDS ?? 1500) - Number(process.env.EMITTER_FROM ?? 1) + 1) + 3);
    const seeds = Number(process.env.EMITTER_SEEDS ?? 1500) - Number(process.env.EMITTER_FROM ?? 1) + 1;
    expect(taken).toBeGreaterThan(0.96 * seeds);
    expect(deep).toBeGreaterThan(0.4 * seeds);
  // (A longer look, EMITTER_SEEDS, takes as long as it takes.)
  }, process.env.EMITTER_SEEDS ? 3_600_000 : RANDOM_PROGRAMS);
});

describe("a map of our own, units", () => {
  const TABLE = 0x59cca8;
  /** The groups a trigger's unit classes go by, as units.dat has them for the types these tests use (Men, Buildings, Factories). */
  const GROUPS: Record<number, number> = { 0: 0x08, 1: 0x08, 37: 0x08, 106: 0x30, 109: 0x10 };
  const MAX_HP: Record<number, number> = { 0: 40, 1: 45, 37: 35, 106: 1500, 109: 500 };
  /**
   * The units laid out where the game keeps them, in the places it hands out first — place 0, then 1 699 down — and the
   * tables a unit's numbers come from; the simulator's world holds the same units, made in the same order.
   */
  const memoryOf = (units: SimUnitInit[], locations: Record<number, SimBounds>): Map<number, number> => {
    const memory = new Map<number, number>();
    const put = (addr: number, value: number, bytes = 4) => {
      const a = addr & ~3, sh = 8 * (addr & 3), mask = bytes === 4 ? 0xffffffff : ((2 ** (8 * bytes) - 1) * 2 ** sh) >>> 0;
      memory.set(a, (((memory.get(a) ?? 0) & ~mask) | ((value * 2 ** sh) & mask)) >>> 0);
    };
    units.forEach((u, i) => {
      const slot = i === 0 ? 0 : 1700 - i, at = TABLE + 336 * slot;
      put(at + 0x08, (u.hp ?? MAX_HP[u.type]) * 256);
      put(at + 0x0c, 0x700000 + 4 * slot);
      put(at + 0x28, u.x ?? 0, 2);
      put(at + 0x2a, u.y ?? 0, 2);
      put(at + 0x4c, u.owner, 1);
      put(at + 0x4d, u.orderId ?? 3, 1);
      put(at + 0x60, (u.shields ?? 0) * 256);
      put(at + 0x64, u.type, 2);
      put(at + 0x8f, u.kills ?? 0, 1);
      put(at + 0xa2, (u.energy ?? 0) * 256, 2);
    });
    for (const [type, hp] of Object.entries(MAX_HP)) put(0x662350 + 4 * Number(type), hp * 256);
    for (const [type, g] of Object.entries(GROUPS)) put(0x6637a0 + Number(type), g, 1);
    for (const [n, b] of Object.entries(locations)) {
      const at = 0x58dc60 + 20 * (Number(n) - 1);
      [b.left, b.top, b.right, b.bottom].forEach((v, i) => put(at + 4 * i, v));
    }
    return memory;
  };
  /** What a program prints as the simulator runs it among these units, and as its payload does, walked from its bytes. */
  const both = (body: string, units: SimUnitInit[], locations: Record<number, SimBounds> = {}): { want: string[]; got: string[] } => {
    const r = compileScript(ts, { "main.ts": `program(() => {\n${body}\n});\n` }, defaultScriptNames(), { lib: defaultLib(), emitter: false });
    expect(r.diagnostics).toEqual([]);
    const hex = (text: string) => shown([...new TextEncoder().encode(text)]);
    const full = units.map((u) => ({ hp: MAX_HP[u.type], maxHp: MAX_HP[u.type], orderId: 3, ...u }));
    const world = new Simulation([], { units: full, locations, strings: r.strings, unitClass: (type, cls) => cls === 229 || ((GROUPS[type] ?? 0) & ({ 230: 0x08, 231: 0x10, 232: 0x20 }[cls] ?? 0)) !== 0 });
    // (The texts shown: a unit killed is an event of its own, with a text that says which.)
    const want = simulatePrograms(r.ir, 1, { world, strings: r.strings }).events.filter((e) => e.text !== undefined && e.action.type === 9).map((e) => hex(e.text!));
    const o = emitOwn(r);
    if (typeof o === "string") throw new Error(o);
    PRINTED.got = [];
    runOwn(o.runs[0].graph, memoryOf(full, locations), o.values);
    return { want, got: PRINTED.got };
  };
  const same = (body: string, units: SimUnitInit[], locations?: Record<number, SimBounds>) => {
    const r = both(body, units, locations);
    expect(r.want.length).toBeGreaterThan(0);
    expect(r.got).toEqual(r.want);
  };
  // P1: a Command Center and three Marines; P2: four Zerglings, one a little hurt; P12: a Supply Depot.
  const UNITS: SimUnitInit[] = [
    { type: 106, owner: 0, x: 400, y: 300 },
    { type: 0, owner: 0, x: 420, y: 340, kills: 2 },
    { type: 0, owner: 0, x: 900, y: 900, shields: 10, energy: 50 },
    { type: 37, owner: 1, x: 1000, y: 1000 },
    { type: 37, owner: 1, x: 1040, y: 980, hp: 20 },
    { type: 0, owner: 0, x: 430, y: 330 },
    { type: 37, owner: 1, x: 300, y: 310 },
    { type: 109, owner: 11, x: 1500, y: 100 },
    { type: 37, owner: 1, x: 1020, y: 1060 },
  ];
  const HOME = { 1: { left: 380, top: 280, right: 460, bottom: 360 } };

  it("counts the units a filter matches, oldest first, and stops at a break", () => {
    same([
      "  let all = 0, mine = 0, lings = 0, men = 0, buildings = 0, factories = 0, home = 0;",
      "  for (const u of allUnits()) all += 1;",
      "  for (const u of unitsOf(P1)) mine += 1;",
      "  for (const u of unitsOf(P2, { type: units.ZergZergling })) lings += 1;",
      "  for (const u of unitsOf(P1, { type: units.Men })) men += 1;",
      "  for (const u of allUnits({ type: units.Buildings })) buildings += 1;",
      "  for (const u of allUnits({ type: units.Factories })) factories += 1;",
      "  for (const u of unitsAt(1 as Location)) home += 1;",
      "  print(`${all} ${mine} ${lings} ${men} ${buildings} ${factories} ${home}`);",
      "  let seen = 0, xs = 0;",
      "  for (const u of allUnits()) { xs += u.x; seen += 1; if (seen == 4) break; }",
      "  let skipped = 0;",
      "  for (const u of unitsOf(P2)) { if (u.hp < 30) continue; skipped += u.hp; }",
      "  print(`${seen} ${xs} ${skipped}`);",
    ].join("\n"), UNITS, HOME);
  });

  it("reads a unit's numbers and flags, and finds none where none is", () => {
    same([
      "  const m = first({ owner: P1, type: units.TerranMarine });",
      "  if (m) print(`${m.hp} ${m.maxHp} ${m.shields} ${m.energy} ${m.owner} ${m.type} ${m.kills} ${m.x} ${m.y} ${m.orderId} ${m.invincible} ${m.cloaked}`);",
      "  const z = first({ owner: P2, type: units.ZergZergling });",
      "  if (first({ owner: P3 }) == null && z && m != z && m == first({ owner: P1, type: units.TerranMarine })) print(`${z.hp} none ok`);",
      "  const n = nearest(units.ZergZergling, 1 as Location, { owner: P2 });",
      "  if (n) print(`nearest at ${n.x},${n.y}`);",
    ].join("\n"), UNITS, HOME);
  });

  it("writes a unit's numbers, damages and heals it, and kills it", () => {
    same([
      "  const m = first({ owner: P1, type: units.TerranMarine })!;",
      "  m.hp = 10;",
      "  const a = m.hp;",
      "  m.heal(5);",
      "  const b = m.hp;",
      "  m.damage(3);",
      "  const c = m.hp;",
      "  m.heal({ percent: 50 });",
      "  m.kills = 300;",
      "  m.energy = 70;",
      "  m.invincible = true;",
      "  print(`${a} ${b} ${c} ${m.hp} ${m.kills} ${m.energy} ${m.invincible}`);",
      "  const z = first({ owner: P2, type: units.ZergZergling });",
      "  z?.damage(100);",
      "  if (z) print(\"still there\"); else print(\"killed\");",
      "  let lings = 0;",
      "  for (const u of unitsOf(P2)) { lings += 1; u.hp = u.maxHp / 2; }",
      "  let hp = 0;",
      "  for (const u of unitsOf(P2)) hp += u.hp;",
      "  print(`${lings} ${hp}`);",
    ].join("\n"), UNITS, HOME);
  });

  it("walks a table every place of which has been handed out once, place 0 among them, one place a turn and two", () => {
    const full: SimUnitInit[] = Array.from({ length: 1700 }, (_, i) => ({ type: i % 3 ? 0 : 37, owner: i % 3 ? 0 : 1, x: 100 + (i % 50), y: 100 + Math.floor(i / 50) }));
    same([
      "  let all = 0, mine = 0, odd = 0;",
      // (Two places a turn: a small body without a `continue`.)
      "  for (const u of allUnits()) all += 1;",
      // (One place a turn: a `continue` reaches the loop.)
      "  for (const u of unitsOf(P1)) { if (u.x % 2 == 0) continue; mine += 1; }",
      // (A `continue` inside a switch is the loop's: one place a turn, place 0's turn wrapped.)
      "  for (const u of unitsOf(P2)) { switch (u.x % 3) { case 0: continue; default: odd += 1; } }",
      "  print(`${all} ${mine} ${odd}`);",
    ].join("\n"), full);
  });

  it("keeps units in variables, arrays and calls", () => {
    same([
      "  const pair: (Unit | null)[] = [first({ owner: P1, type: units.TerranMarine }), first({ owner: P2 })];",
      "  let hp = 0;",
      "  for (const u of pair) if (u) hp += u.hp;",
      "  let best: Unit | null = null;",
      "  let least = 1000;",
      "  for (const u of unitsOf(P2)) if (u.hp < least) { least = u.hp; best = u; }",
      "  if (best) print(`${hp} ${best.hp} ${best.x}`);",
      "  best?.kill();",
      "  if (best) print(\"alive\"); else print(\"gone\");",
    ].join("\n"), UNITS, HOME);
  });
});

describe("a map of our own, errors", () => {
  /** What a script prints as the simulator runs it, and as its payload does, walked from its bytes (one pass). */
  const both = (script: string): { want: string[]; got: string[] } => {
    const r = compileScript(ts, { "main.ts": script }, defaultScriptNames(), { lib: defaultLib(), emitter: false });
    expect(r.diagnostics).toEqual([]);
    const hex = (text: string) => shown([...new TextEncoder().encode(text)]);
    const want = simulatePrograms(r.ir, 1, { strings: r.strings }).events.filter((e) => e.text !== undefined && e.action.type === 9).map((e) => hex(e.text!));
    const o = emitOwn(r);
    if (typeof o === "string") throw new Error(o);
    PRINTED.got = [];
    runOwn(o.runs[0].graph, undefined, o.values);
    return { want, got: PRINTED.got };
  };
  const same = (script: string, lines?: string[]) => {
    const r = both(script);
    expect(r.want.length).toBeGreaterThan(0);
    expect(r.got).toEqual(r.want);
    if (lines) expect(r.want).toEqual(lines.map((l) => shown([...new TextEncoder().encode(l)])));
  };
  /** A program whose `k` is 2, not known when built. */
  const program = (body: string, before = "") => `${before}\nprogram(() => {\n  let k = 0;\n  while (k < 2) k += 1;\n${body}\n});\n`;

  it("goes to the catch of the try around a throw, and on after it", () => {
    same(program([
      "  try {",
      "    if (k > 1) throw new Error(\"too many\");",
      "    print(\"fine\");",
      "  } catch (e) {",
      "    if (e instanceof Error) print(`caught ${e.message}`);",
      "  }",
      "  try { print(\"no throw\"); } catch { print(\"never\"); }",
      "  print(\"after\");",
    ].join("\n")), ["caught too many", "no throw", "after"]);
  });

  it("tells classes of error apart, the script's own with fields among them, and makes a message while the game runs", () => {
    same(program([
      "  for (let i = 0; i < 4; i++) {",
      "    try {",
      "      if (i == 0) throw new Late(k * 5);",
      "      if (i == 1) throw new RangeError(`i is ${i}, k ${k}`);",
      "      if (i == 2) throw new TypeError(\"type\");",
      "      print(`${i} went through`);",
      "    } catch (e) {",
      "      if (e instanceof Late) print(`late by ${e.by}: ${e.message}`);",
      "      else if (e instanceof RangeError) print(`range: ${e.message}`);",
      "      else if (e instanceof Error) print(`other: ${e.message}`);",
      "    }",
      "  }",
    ].join("\n"), "class Late extends Error {\n  by: number;\n  constructor(by: number) {\n    super(\"late\");\n    this.by = by;\n  }\n}"), ["late by 10: late", "range: i is 1, k 2", "other: type", "3 went through"]);
  });

  it("throws a caught error again, to the try further out, and finally runs however the try is left", () => {
    same(program([
      "  let cleaned = 0;",
      "  try {",
      "    try {",
      "      if (k > 1) throw new Error(\"inner\");",
      "    } catch (e) {",
      "      print(\"seen inside\");",
      "      throw e;",
      "    } finally {",
      "      cleaned += 1;",
      "    }",
      "  } catch (e) {",
      "    if (e instanceof Error) print(`caught outside: ${e.message}, cleaned ${cleaned}`);",
      "  }",
      "  for (let i = 0; i < 4; i++) {",
      "    try {",
      "      if (i == 1) continue;",
      "      if (i == 2) break;",
      "    } finally {",
      "      cleaned += 10;",
      "    }",
      "  }",
      "  print(`${cleaned}`);",
    ].join("\n")), ["seen inside", "caught outside: inner, cleaned 1", "31"]);
  });

  it("comes out of called functions to the try around the call, and a function's own try keeps its errors", () => {
    same(program([
      "  let total = 0, n = 0;",
      "  try {",
      "    while (n < 5) {",
      "      total += outer(n);",
      "      n += 1;",
      "    }",
      "  } catch (e) {",
      "    if (e instanceof Error) print(`stopped at ${n}: ${e.message}`);",
      "  }",
      "  try { total += check(k + 7); } catch { total += 1000; }",
      "  print(`${total} ${safe(1)} ${safe(7)}`);",
    ].join("\n"), [
      "function check(n: number) {",
      "  if (n > 2) throw new Error(`too big: ${n}`);",
      "  return n + 1;",
      "}",
      "function outer(n: number) {",
      "  return check(n) * 2;",
      "}",
      "function safe(n: number) {",
      "  try {",
      "    return check(n);",
      "  } catch {",
      "    return -1;",
      "  }",
      "}",
    ].join("\n")), ["stopped at 3: too big: 3", "1012 2 -1"]);
  });

  it("says an error nothing catches in red, where it was thrown, and stops the program there", () => {
    same(program([
      "  print(\"before\");",
      "  if (k > 1) explode(k);",
      "  print(\"after\");",
    ].join("\n"), "function explode(k: number) {\n  throw new RangeError(`k is ${k}`);\n}"), ["before", "\x06TrigScript: uncaught RangeError: k is 2, line 2."]);
  });

  it("comes up through a function that calls itself, its frames taken back on the way", () => {
    same(program([
      "  try {",
      "    print(`${down(k + 3)}`);",
      "  } catch (e) {",
      "    if (e instanceof Error) print(`caught ${e.message}`);",
      "  }",
      "  print(`${halves(k * 20)}`);",
    ].join("\n"), [
      "function down(n: number): number {",
      "  if (n == 0) throw new Error(\"bottom\");",
      "  return down(n - 1) + 1;",
      "}",
      // (Each level keeps `n` and `half` around the call; the catch reads them after the frame is taken back.)
      "function halves(n: number): number {",
      "  const half = n >> 1;",
      "  try {",
      "    if (n < 3) throw new Error(\"small\");",
      "    return halves(half) + n;",
      "  } catch {",
      "    return half * 100 + n;",
      "  }",
      "}",
    ].join("\n")), ["caught bottom", `${40 + 20 + 10 + 5 + 102}`]);
  });

  it("prints what the simulator prints for each of the ledger's scripts of errors", () => {
    for (const name of ["try-catch", "try-finally", "rethrow", "error-class", "error-fields", "error-stack", "throw-from-function", "throw-through-recursion", "finally-on-return", "throw-uncaught", "uncaught-in-function", "stack-overflow-caught"]) {
      const r = both(readFileSync(`ledger/language/${name}.ts`, "utf8"));
      expect([name, r.want.length > 0]).toEqual([name, true]);
      expect([name, r.got]).toEqual([name, r.want]);
    }
  });

  it("lays a loop out the same on an error's way, a throw after it", () => {
    // (Only what runs once before a throw is cold, its reads refreshed from their cells: a loop may turn many times.)
    const lines = (end: string) => {
      const r = compileScript(ts, { "main.ts": `program(() => {\n  let i = 0, s = 0;\n  while (i < 100) {\n    s += i * 3;\n    i += 1;\n  }\n  ${end}\n});\n` }, defaultScriptNames(), { lib: defaultLib(), emitter: false });
      const o = emitOwn(r);
      if (typeof o === "string") throw new Error(o);
      return o.runs[0].graph.triggers.filter((t) => t.at && t.at.line >= 3 && t.at.line <= 5).map((t) => [t.conds.length, t.acts.length, !!t.copy]);
    };
    expect(lines(`throw new Error("done");`)).toEqual(lines(`print("done");`));
    // (And one whose message reads the sum: its read is refreshed where it is made, no place the loop keeps.)
    expect(lines(`throw new Error(\`\${s}\`);`)).toEqual(lines(`print("done");`));
  });

  it("throws a RangeError where a function that calls itself runs out of stack", () => {
    same(program([
      "  try {",
      "    print(`${forever(k)}`);",
      "  } catch (e) {",
      "    if (e instanceof Error) print(`${e instanceof RangeError} ${e.message}`);",
      "  }",
    ].join("\n"), "function forever(n: number): number {\n  if (n > 1000000) return 0;\n  return forever(n + 1) + 1;\n}"), ["true Maximum call stack size exceeded"]);
  });
});
