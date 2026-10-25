// The emitter (compiler/backend/emit.ts) against the meaning of the statements it lowers: random loops of numbers —
// sums, signed, unsigned and mixed comparisons at the edges, if and else, break and continue, loops inside loops —
// each run as written (a small evaluator here) and as the emitter's graph (a small interpreter of graph.ts's triggers:
// conditions compare memory with their own numbers, actions write memory, the walk follows next pointers), from the
// same random values, every variable compared after. The game probe probes/game-emitter.ts does the same in the
// lifted game, for fewer loops.
import { readFileSync, writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { ArrayDecl, BoolExpr, Call, FuncDecl, NumExpr, Stmt, TextPart, VarDecl } from "../compiler/ir";
import { emitBody, emitterCounts } from "../compiler/backend/emit";
import type { ConditionRecord } from "../vendor/triggers";
import { END, SWITCHES, TRIGGER_BYTES, type Dword, type Graph, type Num } from "../compiler/backend/graph";
import { layout, type OwnTriggerInput } from "../compiler/backend/layout";
import { fixedAtan2, fixedDiv, fixedMul, fixedSin, fixedSqrt, fixedText } from "../compiler/fixedMath";
import { SIN_SCALE, atanTable, sinTable } from "../compiler/numbers";
import ts from "typescript";
import { compileScript } from "../compiler/compiler";
import { defaultScriptNames } from "../compiler/names";
import { emitOwn } from "../compiler/backend/own";
import { virtualKey } from "../compiler/input";
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
/** `frames`: the frame each of `got` was shown in, by a walk of several (`runOwn`'s `frames`). */
const PRINTED: { want: string[]; got: string[]; frames: number[] } = { want: [], got: [], frames: [] };
/** The game's actions the harness does not model (Create Unit with Properties, Give Units): a test's world plays them. */
const GAME: { action?: (kind: number, field: (offset: number) => number, read: (addr: number) => number, write: (addr: number, value: number) => void) => void } = {};
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
  // (A scratch cell is the cell of a variable named after it, as the layout has it.)
  if ("temp" in d) return `var:@${d.temp}`;
  if ("template" in d) return `template:${d.template}:${d.word}`;
  if ("cell" in d) return `epd:${TABLE_EPD(d.cell) + 18 * d.index}`;
  const f = d.field;
  return f === "next" || f === "current" || f === "flags" ? `${d.at}|${f}` : "cond" in f ? `${d.at}|cond:${f.cond}${f.part === "player" ? ":player" : f.part === "mask" ? ":mask" : ""}` : `${d.at}|act:${f.act}:${f.part}`;
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
/**
 * `frames`: walked that many times, as the game walks the triggers once a frame — from `@run` (the map's count of frames
 * one more) when more than one, the memory kept from one to the next; each text shown noted with its frame.
 */
/** `between`: what the game does before each frame — memory written, as units come and go. */
/**
 * `lists`: the map's own triggers and the players whose lists the payload is linked into (TrigScript 4, step 13): each
 * frame is then walked as the game walks it, from each player's entry in turn with the current player theirs, instead
 * of from `@run`.
 */
function runOwn(g: Graph, memory?: Map<number, number>, arrays = new Map<string, number[]>(), runs?: { graph: Graph; owner: number }[], frames = 1, between?: (frame: number, write: (addr: number, value: number) => void, read: (addr: number) => number) => void, lists?: { triggers: OwnTriggerInput[]; players: number[] }): Env {
  // (Laid out once a graph: a test may walk one many times.)
  let done = laidOut.get(g);
  if (!done || (done.arrays !== arrays && (done.arrays.size || arrays.size))) {
    // (Strings by number: a printed text's template 1000 on, a text known when built 5000 on.)
    const templates = (runs ? runs.flatMap((r) => r.graph.templates ?? []) : g.templates ?? []).map((t) => t.id), texts: string[] = [];
    // (Every dword no trigger or data holds all ones: nothing reads them.)
    const own = layout({ ...(runs ? { runs } : { graph: g, owner: 0 }), ...(lists ? { triggers: lists.triggers, players: lists.players } : {}), strings: 0, text: (t) => 5000 + (texts.includes(t) ? texts.indexOf(t) : texts.push(t) - 1), arrays, template: (id) => 1000 + templates.indexOf(id), free: 0xffffffff });
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
  PRINTED.frames = [];
  // (A switch's bit where the game keeps it.)
  const switchAt = (sw: number): [number, number] => [SWITCHES + 4 * (sw >> 5), 2 ** (sw & 31)];
  for (let frame = 1; frame <= frames; frame++) {
  between?.(frame, wr, rd);
  // (With the lists: each player's list in turn, from their entry, the current player theirs, as the game walks them.)
  const starts: number[] = lists ? lists.players.map((p) => own.triggers.get(`@entry${p}`)!) : [frames > 1 ? own.triggers.get("@run")! : own.address];
  const shownBefore = PRINTED.got.length;
  starts.forEach((start, w) => {
  if (lists) wr(0x6509b0, lists.players[w]);
  let pc = start;
  for (let steps = 0; !(pc & 0x80000000); steps++) {
    if (steps > Number(process.env.OWN_STEPS ?? 200_000_000)) throw new Error("the payload does not end");
    if (!inside(pc)) throw new Error(`the walk left the payload: 0x${pc.toString(16)}`);
    let holds = (rd(pc + 2376) & 8) === 0;
    for (let k = 0; holds && k < 16; k++) {
      const o = pc + 8 + 20 * k, kind = byte(o + 15);
      // (As the game: one switched off is passed over before the kind is asked.)
      if (byte(o + 17) & 2) continue;
      if (kind === 0) break;
      // (The game's own conditions a trigger of the map's own may have: Always, Never, Switch.)
      if (kind === 22) continue;
      if (kind === 23) { holds = false; continue; }
      if (kind === 11) {
        const [addr, bit] = switchAt(byte(o + 16));
        holds = byte(o + 14) === 2 ? (rd(addr) & bit) !== 0 : (rd(addr) & bit) === 0;
        continue;
      }
      if (kind !== 15) throw new Error(`condition kind ${kind}`);
      // (Deaths: the player's dword of the unit's row — an EPD's with unit 0, as the graph's are.)
      const d = at(rd(o + 4)) + 48 * dv.getUint16(o + 12 - base, true);
      const masked = dv.getUint16(o + 18 - base, true) === 0x4353;
      const x = masked ? (rd(d) & rd(o)) >>> 0 : rd(d), y = rd(o + 8), compare = byte(o + 14);
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
        // (A string of the map's own, by its number.)
        if (index < 1000) { PRINTED.got.push(shown([...new TextEncoder().encode(`string ${index}`)])); continue; }
        const out: number[] = [];
        for (let a = own.templates.get(templates[index - 1000])!; byte(a) !== 0; a++) out.push(byte(a));
        PRINTED.got.push(shown(out));
        continue;
      }
      if (kind === 13) {
        // Set Switch: set (4), clear (5), toggle (6), or to a random state (11), its bit where the game keeps it.
        const [addr, bit] = switchAt(rd(o + 20)), modifier = byte(o + 27);
        const on = modifier === 4 ? true : modifier === 5 ? false : modifier === 6 ? (rd(addr) & bit) === 0 : modifier === 11 ? randomBit() !== 0 : null;
        if (on === null) throw new Error(`Set Switch ${modifier}`);
        wr(addr, on ? (rd(addr) | bit) >>> 0 : (rd(addr) & ~bit) >>> 0);
        continue;
      }
      // (Preserve Trigger and Comment, a trigger of the map's own: the trigger kept, and nothing.)
      if (kind === 3) { wr(pc + 2376, rd(pc + 2376) | 4); continue; }
      if (kind === 47) continue;
      // (Play WAV: noted as a sound played, which sound aside.)
      if (kind === 8) { PRINTED.got.push("wav"); continue; }
      // (Create Unit with Properties and Give Units: the game's, which a test's world plays — the units are its.)
      if (kind === 11 || kind === 48) { GAME.action?.(kind, (off) => (off === 27 ? byte(o + 27) : rd(o + off)), rd, wr); continue; }
      if (kind !== 45) throw new Error(`action kind ${kind}`);
      const dest = at(rd(o + 16)) + 48 * dv.getUint16(o + 24 - base, true), value = rd(o + 20), modifier = byte(o + 27), old = rd(dest);
      if (dv.getUint16(o + 30 - base, true) === 0x4353) {
        // (A masked write as the game has it: the bits under the mask of both worked, a carry past them lost.)
        const m = rd(o), f = (old & m) >>> 0, w = (value & m) >>> 0;
        const next = modifier === 7 ? w : modifier === 8 ? u(f + w) : Math.max(0, f - w);
        wr(dest, ((old & ~m) | (next & m)) >>> 0);
        continue;
      }
      wr(dest, modifier === 7 ? value : modifier === 8 ? u(old + value) : Math.max(0, old - value));
    }
    // (As the game: a trigger that ran and is not preserved is switched off.)
    if (holds && !(rd(pc + 2376) & 4)) wr(pc + 2376, rd(pc + 2376) | 8);
    pc = rd(pc + 4);
  }
  });
  for (let i = shownBefore; i < PRINTED.got.length; i++) PRINTED.frames.push(frame);
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

describe("a map of our own, a sum of bit-slices of one read", () => {
  it("folds a sum whose terms are slices of one dword read and a negative constant as the program does (step 12's Open list)", () => {
    // `(v & 0xffff) − 1 + ((v >>> 16) − 1) × 1024` of a dword 0x00050003: 2 + 4 × 1024.
    const decl = (id: string): VarDecl => ({ id, name: id, kind: "number", shared: false, at });
    const v = (id: string): NumExpr => ({ kind: "var", id });
    const c = (value: number): NumExpr => ({ kind: "const", value });
    const bin = (op: "+" | "-" | "*" | "&" | ">>>", left: NumExpr, right: NumExpr): NumExpr => ({ kind: "binary", op, left, right, at, label: "" });
    const deaths: ConditionRecord = { location: 0, player: 1000, amount: 0, unitId: 0, comparison: 0, type: 15, resource: 0, flags: 0, mask: 0 };
    const read: NumExpr = { kind: "read", read: { source: "condition", record: deaths }, at, label: "" } as NumExpr;
    const low = bin("&", v("v"), c(0xffff)), high = bin(">>>", v("v"), c(16));
    const cases: [string, NumExpr, number][] = [
      ["d", bin("+", bin("-", low, c(1)), bin("*", bin("-", high, c(1)), c(1024))), 2 + 4 * 1024],
      ["e", bin("+", bin("-", bin("&", v("v"), c(0xff)), c(3)), bin("-", bin("&", bin(">>>", v("v"), c(8)), c(0xff)), c(5))), u(3 - 3 + (0 - 5))],
      ["f", bin("-", low, c(1025)), u(3 - 1025)],
      ["g", bin("-", bin("*", high, c(1024)), c(1025)), u(5 * 1024 - 1025)],
      ["h", bin("+", low, bin("*", high, c(1024))), 3 + 5 * 1024],
      ["i", bin("-", bin("+", low, high), c(1025)), u(8 - 1025)],
      ["j", bin("+", bin("*", high, c(1024)), c(7)), 5 * 1024 + 7],
      ["k", bin("-", high, c(1)), 4],
    ];
    const body = [{ kind: "declare", decl: decl("v"), init: read, at }, ...cases.map(([id, init]) => ({ kind: "declare", decl: decl(id), init, at }))] as Stmt[];
    const decls = new Map(["v", ...cases.map(([id]) => id)].map((id) => [id, decl(id)]));
    const g = emitBody(body, decls, "bs", undefined, undefined, undefined, 0);
    if (typeof g === "string") throw new Error(g);
    const got = runOwn(g, new Map([[0x58a364 + 4 * 1000, 0x00050003]]));
    expect(cases.map(([id]) => [id, got.get(id)])).toEqual(cases.map(([id, , want]) => [id, want]));
  });
});

describe("a map of our own, texts made while the game runs", () => {
  /** What a one-program script prints, its payload walked from its bytes (one pass: it sleeps nowhere). */
  const printed = (body: string, file = "main.ts", memory?: Map<number, number>): string[] => {
    const r = compileScript(ts, { [file]: `program(() => {\n  let n = 0;\n  while (n < 12) n += 5;\n${body}\n});\n` }, defaultScriptNames(), { lib: defaultLib() });
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
    const r = compileScript(ts, { [file]: source }, defaultScriptNames(), { lib: defaultLib() });
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
      put(at + 0x38, u.speed ?? 0);
      put(at + 0x5c, u.hasTarget ? 0x700000 + 4 : 0);
      put(at + 0x8e, u.rank ?? 0, 1);
      put(at + 0xac, u.buildTime ?? 0, 2);
      put(at + 0x114, u.matrix ?? 0, 1);
      put(at + 0xdc, (u.invincible ? 0x04000000 : 0) | (u.hallucinated ? 0x40000000 : 0) | (u.speedUpgrade ? 0x10000000 : 0) | (u.inTransport ? 0x40 : 0) | (u.burrowed ? 0x10 : 0));
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
    const r = compileScript(ts, { "main.ts": `program(() => {\n${body}\n});\n` }, defaultScriptNames(), { lib: defaultLib() });
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

  it("reads and writes the fields Magenta's rows need: build time, rank, matrix, speed and the flags", () => {
    const units: SimUnitInit[] = [
      { type: 106, owner: 0, x: 400, y: 300, buildTime: 900, rank: 2, speed: 0 },
      { type: 0, owner: 0, x: 420, y: 340, speed: 1024, hasTarget: true, speedUpgrade: true, matrix: 100 },
      { type: 0, owner: 0, x: 430, y: 330, inTransport: true, hallucinated: true },
    ];
    same([
      "  const cc = first({ type: units.TerranCommandCenter })!;",
      "  const m = first({ type: units.TerranMarine })!;",
      "  const t = first({ type: units.TerranMarine, owner: P1 })!;",
      "  let second: Unit | null = null;",
      "  for (const u of unitsOf(P1, { type: units.TerranMarine })) second = u;",
      "  print(`${cc.buildTime} ${cc.rank} ${cc.speed} ${m.speed} ${m.hasTarget} ${m.speedUpgrade} ${m.matrix} ${m.inTransport} ${m.hallucinated}`);",
      "  if (second) print(`${second.inTransport} ${second.hallucinated} ${second.hasTarget} ${second.speedUpgrade}`);",
      "  cc.buildTime = 60; cc.rank = 7; m.matrix = 40; m.speedUpgrade = false; m.hallucinated = true; cc.rank += 1;",
      "  print(`${cc.buildTime} ${cc.rank} ${m.matrix} ${m.speedUpgrade} ${m.hallucinated}`);",
      "  m.matrix = 0; cc.buildTime = 70000; m.rank = 300;",
      "  print(`${m.matrix} ${cc.buildTime} ${m.rank}`);",
    ].join("\n"), units, HOME);
  });

  it("reads a location's bounds and moves one edge at a time", () => {
    same([
      "  const b = bounds(1 as Location);",
      "  print(`${b.left} ${b.top} ${b.right} ${b.bottom}`);",
      "  b.left += 32; b.right += 32; b.top = 0; b.bottom -= 16;",
      "  print(`${b.left} ${b.top} ${b.right} ${b.bottom} ${bounds(1 as Location).right - bounds(1 as Location).left}`);",
      "  const { left, top } = bounds(1 as Location);",
      "  print(`${left} ${top}`);",
      "  let n = 0;",
      "  for (const u of unitsAt(1 as Location)) n += 1;",
      "  print(`${n}`);",
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
    const r = compileScript(ts, { "main.ts": script }, defaultScriptNames(), { lib: defaultLib() });
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
      const r = compileScript(ts, { "main.ts": `program(() => {\n  let i = 0, s = 0;\n  while (i < 100) {\n    s += i * 3;\n    i += 1;\n  }\n  ${end}\n});\n` }, defaultScriptNames(), { lib: defaultLib() });
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

describe("a map of our own, tasks", () => {
  /**
   * What a script prints over so many frames, each text with its frame — and each sound played, as "wav": as the
   * simulator runs it, and from its payload's bytes (every run of it, one a player of a program for each).
   */
  const both = (script: string, frames: number, file = "main.ts"): { want: string[]; got: string[] } => {
    const r = compileScript(ts, { [file]: script }, defaultScriptNames(), { lib: defaultLib() });
    expect(r.diagnostics).toEqual([]);
    const hex = (text: string) => shown([...new TextEncoder().encode(text)]);
    const events = simulatePrograms(r.ir, frames, { strings: r.strings }).events.filter((e) => (e.text !== undefined && e.action.type === 9) || e.action.type === 8);
    const first = events[0]?.frame ?? 0;
    const want = events.map((e) => `${e.frame - first} ${e.action.type === 8 ? "wav" : hex(e.text!)}`);
    // (Player 1 alone in the game, as the simulator runs a program for each player: for the first.)
    const o = emitOwn(r, { slots: [0], forces: [0, 0, 0, 0, 0, 0, 0, 0] });
    if (typeof o === "string") throw new Error(o);
    PRINTED.got = [];
    runOwn(o.runs[0].graph, undefined, o.values, o.runs.length > 1 ? o.runs.map((x) => ({ graph: x.graph, owner: x.player })) : undefined, frames);
    const start = PRINTED.frames[0] ?? 0;
    return { want, got: PRINTED.got.map((t, i) => `${PRINTED.frames[i] - start} ${t}`) };
  };
  for (const path of ["sounds/music-loop.ts", "texts/ui-lines.tsx", "programs/owner-all-players-tasks.ts"]) it(`runs ledger/${path} as the simulator does, frame for frame`, () => {
    const r = both(readFileSync(`ledger/${path}`, "utf8"), 200, path.endsWith(".tsx") ? "main.tsx" : "main.ts");
    expect(r.want.length).toBeGreaterThan(0);
    expect(r.got).toEqual(r.want);
  });
  const ROWS = ["start-call", "start-arrow", "start-void", "start-max", "task-awaited", "task-running", "task-cancel", "task-outlives-program", "task-starts-a-task", "generator-as-a-task", "timers-after", "timers-every", "timers-every-times", "timers-every-cancelled", "promise-all", "promise-all-values", "promise-race", "promise-any", "task-error-awaited", "task-error-not-awaited"];
  for (const name of ROWS) it(`runs ledger/tasks/${name} as the simulator does, frame for frame`, () => {
    const r = both(readFileSync(`ledger/tasks/${name}.ts`, "utf8"), 200);
    // (A task cancelled says nothing: the tests below do.)
    if (name !== "task-cancel") expect(r.want.length).toBeGreaterThan(0);
    expect(r.got).toEqual(r.want);
  });
  const same = (script: string, frames = 120) => {
    const r = both(script, frames);
    expect(r.want.length).toBeGreaterThan(0);
    expect(r.got).toEqual(r.want);
  };

  it("cancels a task where it waits, and says it no longer runs", () => {
    same([
      "async function ticker(name: number) {",
      "  let i = 0;",
      "  while (true) {",
      "    print(`${name}: ${i}`);",
      "    i += 1;",
      "    await sleep(frames(2));",
      "  }",
      "}",
      "program(async () => {",

      "  const a = start(ticker(1));",
      "  const b = start(ticker(2));",
      "  await sleep(frames(5));",
      "  a.cancel();",
      "  print(`${a.running} ${b.running}`);",
      "  await sleep(frames(4));",
      "  b.cancel();",
      "  a.cancel();",
      "  print(`${a.running} ${b.running}`);",
      "});",
    ].join("\n"));
  });

  it("gives a start's tasks its slots, says once when all run, and reuses a slot with a new number", () => {
    // (The game says in red that a task did not start, as the Python side's build does; the simulator notes a fault.)
    const r = both([
      "async function wave(n: number) {",
      "  await sleep(frames(n));",
      "  print(`wave ${n}`);",
      "}",
      "program(async () => {",
      "  let n = 1;",
      "  while (n <= 4) {",
      "    const t = start(wave(n * 2), { max: 2 });",
      "    print(`${n}: ${t.running}`);",
      "    n += 1;",
      "  }",
      "  await sleep(frames(3));",
      "  n = 1;",
      "  while (n <= 2) {",
      "    const t = start(wave(n), { max: 2 });",
      "    print(`again ${n}: ${t.running}`);",
      "    n += 1;",
      "  }",
      "  await sleep(frames(10));",
      "});",
    ].join("\n"), 120);
    const said = shown([...new TextEncoder().encode("\x06TrigScript: wave did not start, line 8 - all 2 of this start's tasks are running.")]);
    expect(r.got.filter((t) => t.endsWith(said))).toEqual([`0 ${said}`]);
    expect(r.got.filter((t) => !t.endsWith(said))).toEqual(r.want);
  });

  it("starts a task from a task later in the turn, and earlier, in the frame it is started", () => {
    same([
      "async function late(n: number) {",
      "  print(`late ${n} starts`);",
      "  await sleep(frames(1));",
      "  print(`late ${n} ends`);",
      "}",
      "async function early() {",
      "  await sleep(frames(2));",
      "  print(\"early starts late\");",
      "  start(late(1));",
      "  await sleep(frames(2));",
      "}",
      "program(async () => {",
      "  start(late(0));",
      "  start(early());",
      "  print(\"program\");",
      "});",
    ].join("\n"));
  });

  it("waits for branches inside a task, and a race inside a branch", () => {
    same([
      "async function pause(n: number): Promise<number> {",
      "  await sleep(frames(n));",
      "  return n;",
      "}",
      "async function pair(): Promise<number> {",
      "  const [a, b] = await Promise.all([pause(2), pause(5)]);",
      "  return a + b;",
      "}",
      "async function task() {",
      "  const [x, y] = await Promise.all([pair(), Promise.race([pause(3), pause(7)])]);",
      "  print(`task ${x} ${y}`);",
      "}",
      "program(async () => {",
      "  start(task());",
      "  let i = 0;",
      "  while (i < 8) { print(`frame ${i}`); i += 1; await sleep(frames(1)); }",
      "});",
    ].join("\n"));
  });

  it("throws in a task to its own catch, and to the program waiting on it", () => {
    same([
      "async function risky(n: number) {",
      "  await sleep(frames(n));",
      "  try {",
      "    if (n > 1) throw new RangeError(`n is ${n}`);",
      "  } catch (e) {",
      "    if (e instanceof RangeError) print(`caught in the task: ${e.message}`);",
      "  }",
      "  if (n > 2) throw new Error(`gave up at ${n}`);",
      "  print(`task ${n} ends`);",
      "}",
      "program(async () => {",
      "  const a = start(risky(1));",
      "  const b = start(risky(3));",
      "  await a;",
      "  print(\"a done\");",
      "  try {",
      "    await b;",
      "  } catch (e) {",
      "    if (e instanceof Error) print(`the program caught: ${e.message}`);",
      "  }",
      "});",
    ].join("\n"));
  });
});

describe("a map of our own, unit events", () => {
  /**
   * The game's unit table as the game keeps it, two units to start with in the places it hands out first (0, then
   * 1 699); each frame the world may change (`then`), and the payload is walked from its bytes.
   */
  const TABLE = 0x59cca8, place = (k: number) => TABLE + 336 * k;
  const run = (script: string, frames: number, then: (frame: number, w: (addr: number, value: number) => void) => void): string[] => {
    const r = compileScript(ts, { "main.ts": script }, defaultScriptNames(), { lib: defaultLib() });
    expect(r.diagnostics).toEqual([]);
    const o = emitOwn(r);
    if (typeof o === "string") throw new Error(o);
    const memory = new Map<number, number>();
    const unit = (k: number, type: number, uid: number, order = 3) => {
      memory.set(place(k) + 0x08, 40 * 256);
      memory.set(place(k) + 0x0c, 0x700000 + k);
      memory.set(place(k) + 0x4c, order * 256);
      memory.set(place(k) + 0x64, type);
      memory.set(place(k) + 0xa4, uid * 256);
    };
    unit(0, 0, 9);
    unit(1699, 37, 8);
    // (The game's head of free places — the place it hands out next — and Player 1's count of units, which the watch's
    // gate reads: both units are Player 1's.)
    memory.set(0x628438, place(1698));
    memory.set(0x581de4, 2);
    PRINTED.got = [];
    runOwn(o.runs[0].graph, memory, o.values, undefined, frames, then);
    return PRINTED.got.map((t, i) => `${PRINTED.frames[i]} ${Buffer.from(t, "hex").toString()}`);
  };

  it("hands on what came on, died, was killed, took up an order and turned into another type, in the frame it did", () => {
    const got = run([
      "program(async () => {",
      "  on.created((u) => { print(`made ${u.type}`); });",
      "  on.died((u) => { print(`died ${u.type}`); });",
      "  on.killed((u, by) => { print(`killed ${u.type} by ${by}`); });",
      "  on.order((u, order, was) => { print(`order ${u.type} ${order} ${was}`); });",
      "  on.morphed((u, was) => { print(`morphed ${u.type} from ${was}`); });",
      "});",
    ].join("\n"), 14, (f, w) => {
      // Frame 3: a Marine at place 1698, the next the game hands out. Frame 5: the Marine at place 0 takes up order 6.
      // Frame 7: the Zergling turns into type 38. Frame 9: the new Marine dies in a fight with Player 1's: no hit
      // points, the order Die. Frame 11: it is gone, and a Firebat (type 32) is handed its place, the uniqueness byte
      // one on.
      if (f === 3) { w(place(1698) + 0x08, 40 * 256); w(place(1698) + 0x0c, 0x700001); w(place(1698) + 0x4c, 0x0300); w(place(1698) + 0xa4, 7 * 256); }
      if (f === 5) w(place(0) + 0x4c, 0x0600);
      if (f === 7) w(place(1699) + 0x64, 38);
      if (f === 9) { w(place(1698) + 0x08, 0); w(place(1698) + 0x4c, 0x0000); w(place(1698) + 0x90, 0); }
      if (f === 10) w(place(1698) + 0x0c, 0);
      if (f === 11) { w(place(1698) + 0x08, 50 * 256); w(place(1698) + 0x0c, 0x700002); w(place(1698) + 0x4c, 0x0300); w(place(1698) + 0x64, 32); w(place(1698) + 0xa4, 8 * 256); }
    });
    expect(got).toEqual(["3 made 0", "5 order 0 6 3", "7 morphed 38 from 37", "9 died 0", "9 killed 0 by 0", "11 made 32"]);
  });

  it("reads a died unit's type and place as they are, its order Die and its sprite still there", () => {
    // (A unit handed to a died handler is on its way out: its record holds its type and place still, and a read of
    // them asks only that the place holds the record — not that it is alive. The first play of the events probe,
    // 2026-10-24, printed "died 0 at 0, 0" for every unit, Firebats included.)
    const got = run([
      "program(async () => {",
      "  on.died((u) => { print(`died ${u.type} at ${u.x}, ${u.y}`); });",
      "});",
    ].join("\n"), 10, (f, w) => {
      // (Deaths alone: the watch is gated, so the game's head of free places and Player 1's count move as the game moves them.)
      if (f === 3) { w(place(1698) + 0x08, 40 * 256); w(place(1698) + 0x0c, 0x700001); w(place(1698) + 0x28, 100 | (200 << 16)); w(place(1698) + 0x4c, 0x0300); w(place(1698) + 0x64, 32); w(place(1698) + 0xa4, 7 * 256); w(0x628438, place(1697)); w(0x581de4, 3); }
      if (f === 6) { w(place(1698) + 0x08, 0); w(place(1698) + 0x4c, 0x0000); w(0x581de4, 2); }
    });
    expect(got).toEqual(["6 died 32 at 100, 200"]);
  });

  it("starts a task for each unit a handler that waits is handed, and passes the watch by while the game's free list and counts stand still", () => {
    // (No orders or types watched: the watch is gated. The game's head of free places (0x628438) and Player 1's count
    // of units (0x581DE4) move as the game moves them when a unit is made; a unit put in a place with neither moved is
    // not seen until one does.)
    const FREE_HEAD = 0x628438, UNITS_P1 = 0x581de4;
    const got = run([
      "program(async () => {",
      "  on.created(async (u) => { await sleep(frames(2)); print(`late ${u.type}`); });",
      "});",
    ].join("\n"), 12, (f, w) => {
      const unit = (kk: number, uid: number) => { w(place(kk) + 0x0c, 0x700001); w(place(kk) + 0x4c, 0x0300); w(place(kk) + 0x64, 5); w(place(kk) + 0xa4, uid * 256); };
      if (f === 3) { for (const [kk, uid] of [[1698, 7], [1697, 6]]) unit(kk, uid); w(FREE_HEAD, place(1696)); w(UNITS_P1, 4); }
      if (f === 6) unit(1696, 5);
      if (f === 8) w(UNITS_P1, 5);
    });
    expect(got).toEqual(["5 late 5", "5 late 5", "10 late 5"]);
  });
});

describe("a map of our own, the map's own triggers", () => {
  /**
   * The lists as the game keeps them: a player not in the game has an empty one (its last pointer the list's own end),
   * and each frame is walked from each player's entry in turn.
   */
  const LISTS = 0x51a280;
  const run = (script: string, frames: number, slots: number[]): string[] => {
    const r = compileScript(ts, { "main.ts": script }, defaultScriptNames(), { lib: defaultLib() });
    expect(r.diagnostics).toEqual([]);
    const o = emitOwn(r, { slots, forces: [0, 1, 1, 0, 0, 0, 0, 0] });
    if (typeof o === "string") throw new Error(o);
    const memory = new Map<number, number>();
    for (let q = 0; q < 8; q++) if (!slots.includes(q)) memory.set(LISTS + 12 * q + 8, u(~(LISTS + 12 * q + 4)));
    PRINTED.got = [];
    runOwn(o.runs[0].graph, memory, o.values, o.runs.map((x) => ({ graph: x.graph, owner: x.player })), frames, undefined, { triggers: o.triggers, players: slots });
    return PRINTED.got.map((t, i) => `${PRINTED.frames[i]} ${Buffer.from(t, "hex").toString()}`);
  };

  it("runs each player's own triggers in turn before the programs, every frame, and switches one that is not preserved off once it has run", () => {
    const got = run([
      `trigger(P1, [always()], [setDeaths(P1, units.TerranMarine, "add", 1), preserve()]);`,
      `trigger(P2, [always()], [displayText("P2 once")]);`,
      `trigger(AllPlayers, [switchIs(switches.Switch1, "set")], [displayText("switched"), comment("a name"), preserve()]);`,
      `trigger(P1, [deaths(P1, units.TerranMarine, ">=", 3)], [displayText("three"), setSwitch(switches.Switch1, "set")]);`,
      "program(async () => {",
      "  for (let i = 0; i < 4; i++) { print(`d ${deaths(P1, units.TerranMarine)}`); await sleep(frames(1)); }",
      "});",
    ].join("\n"), 4, [0, 1]);
    // Frame 3: Player 1's third trigger fires once and sets the switch; Player 2's copy of the All Players trigger,
    // walked after Player 1's list, sees it the same frame; the program, after every player's triggers, reads the count
    // the first trigger added to that frame.
    expect(got).toEqual(["1 P2 once", "1 d 1", "2 d 2", "3 three", "3 switched", "3 d 3", "4 switched", "4 switched", "4 d 4"]);
  });

  it("runs the programs from the last player's list that is there, after every player's triggers, and leaves a player not in the game out", () => {
    const got = run([
      `trigger(P3, [always()], [displayText("P3"), preserve()]);`,
      `trigger([P1, P2, P4], [always()], [displayText("P1 P2 P4"), preserve()]);`,
      `program(() => { print("program"); });`,
    ].join("\n"), 2, [0, 2, 3]);
    expect(got).toEqual(["1 P1 P2 P4", "1 P3", "1 P1 P2 P4", "1 program", "2 P1 P2 P4", "2 P3", "2 P1 P2 P4"]);
  });
});

describe("a map of our own, input", () => {
  /**
   * The game's side of the channel, played by the test: Player 12's list holds the carriers the start-up finds (six a
   * ring), the local player's keys and mouse are its memory, and what the send pass queues is read back as the game
   * would run it two frames on — a Select names the carrier, a Move writes its order target.
   */
  const TABLE = 0x59cca8, place = (k: number) => TABLE + 336 * k;
  const LOCAL = 0x512684, QUEUE = 0x654880, QUEUED = 0x654aa0, QUEUE_MOST = 0x57f0d8, FIRST_UNIT = 0x6283f8, KEYS = 0x596a18, BUTTONS = 0x6cddc0, MOUSE = 0x6cddc4, SCREEN_X = 0x62848c, SCREEN_Y = 0x6284a8, SELECTION = 0x6284b8;
  type World = { keys: Map<number, number>; buttons: number; mouse: [number, number]; screen: [number, number]; selection: number[]; pokes: [number, number][] };
  const run = (script: string, frames: number, then: (frame: number, world: World) => void, mouse = false): { lines: string[]; sent: string[] } => {
    const r = compileScript(ts, { "main.ts": script }, defaultScriptNames(), { lib: defaultLib() });
    expect(r.diagnostics).toEqual([]);
    const o = emitOwn(r, { slots: [0, 1], forces: [0, 1, 0, 0, 0, 0, 0, 0] }, 1, { humans: [0, 1], width: 64 * 32, height: 64 * 32, cuwp: 64 });
    if (typeof o === "string") throw new Error(o);
    const memory = new Map<number, number>();
    memory.set(LOCAL, 0);
    memory.set(QUEUE_MOST, 496);
    // The units the game hands each human's Create Unit (a pool a human, from place 1600 on): Give Units puts the
    // count asked at the head of Player 12's list, the newest first, as the game does.
    const perHuman = (mouse ? 12 : 6);
    const pools = new Map<number, number[]>([[0, []], [1, []]]);
    let next = 1600;
    for (const h of [0, 1]) for (let i = 0; i < perHuman; i++) {
      const k = next++;
      memory.set(place(k) + 0x0c, 0x700000 + k);
      memory.set(place(k) + 0x4c, 3 * 256 + h);
      memory.set(place(k) + 0x64, 58);
      memory.set(place(k) + 0xa4, (i + 1) * 256);
      pools.get(h)!.push(k);
    }
    GAME.action = (kind, field, rd, w) => {
      if (kind !== 48) return;
      const h = field(16), count = field(27);
      for (let i = 0; i < count; i++) {
        const k = pools.get(h)!.shift()!;
        w(place(k) + 0x6c, rd(FIRST_UNIT + 11 * 4));
        w(place(k) + 0x4c, 3 * 256 + 11);
        w(FIRST_UNIT + 11 * 4, place(k));
      }
    };
    const world: World = { keys: new Map(), buttons: 0, mouse: [0, 0], screen: [0, 0], selection: [], pokes: [] };
    const sent: string[] = [];
    // (What the queue holds at the end of a frame, applied two frames on.)
    const due = new Map<number, { slot: number; x: number; y: number }[]>();
    PRINTED.got = [];
    const env = runOwn(o.runs[0].graph, memory, o.values, undefined, frames, (f, w, rd) => {
      // The commands of the frame before, as the game sends them: each Select names units, a Move gives the selection a target.
      const n = rd(QUEUED);
      const bytes: number[] = [];
      for (let a = QUEUE; a < QUEUE + n; a += 4) { const d = rd(a); bytes.push(d & 0xff, (d >> 8) & 0xff, (d >> 16) & 0xff, (d >>> 24) & 0xff); }
      bytes.length = n;
      let selected: number[] = [];
      for (let i = 0; i < bytes.length;) {
        const c = bytes[i];
        if (c === 0x05) { i++; continue; }
        if (c === 0x09) { const count = bytes[i + 1]; selected = []; for (let t = 0; t < count; t++) selected.push((bytes[i + 2 + 2 * t] | (bytes[i + 3 + 2 * t] << 8)) & 0x7ff); sent.push(`${f - 1} select ${selected.map((t) => t - 1).join(",")}`); i += 2 + 2 * count; continue; }
        if (c === 0x15) { const x = bytes[i + 1] | (bytes[i + 2] << 8), y = bytes[i + 3] | (bytes[i + 4] << 8); sent.push(`${f - 1} move ${x},${y}`); for (const t of selected) due.set(f + 1, [...(due.get(f + 1) ?? []), { slot: t - 1, x, y }]); i += 12; continue; }
        throw new Error(`a command the test does not know: 0x${c.toString(16)} at ${i} of ${bytes.length}`);
      }
      w(QUEUED, 0);
      for (const d of due.get(f) ?? []) w(place(d.slot) + 0x58, (d.x | (d.y << 16)) >>> 0);
      if (process.env.IN_DEBUG) console.log(`frame ${f}: made ${rd(0x58a364 + 4 * 0)} c0+58 ${rd(place(1600) + 0x58)} c1+58 ${rd(place(1601) + 0x58)} first12 ${rd(FIRST_UNIT + 44).toString(16)}`);
      then(f, world);
      for (const [a, v] of world.pokes.splice(0)) w(a, v);
      // The local machine's memory as the world says.
      const keyWords = new Map<number, number>();
      for (const [vk, down] of world.keys) if (down) keyWords.set((KEYS + vk) & ~3, (keyWords.get((KEYS + vk) & ~3) ?? 0) | (1 << (8 * ((KEYS + vk) & 3))));
      for (let a = KEYS; a < KEYS + 256; a += 4) w(a, keyWords.get(a) ?? 0);
      w(BUTTONS, world.buttons);
      w(MOUSE, world.mouse[0]); w(MOUSE + 4, world.mouse[1]); w(SCREEN_X, world.screen[0]); w(SCREEN_Y, world.screen[1]);
      for (let i = 0; i < 12; i++) w(SELECTION + 4 * i, world.selection[i] !== undefined ? place(world.selection[i]) : 0);
    });
    if (process.env.IN_DEBUG) console.log([...env].filter(([id]) => id.startsWith("@in")).map(([id, v]) => `${id}=${v}`).join(" "));
    return { lines: PRINTED.got.map((t, i) => `${PRINTED.frames[i]} ${Buffer.from(t, "hex").toString()}`), sent };
  };
  const vk = (key: string) => virtualKey(key)!;

  it("makes the carriers at the first frame: Player 12's units, the owner byte the player's, nothing sent", () => {
    const owners: number[] = [];
    const got = run("program(async () => { while (true) { if (keyPressed(P1, \"F7\")) print(\"help\"); await nextFrame(); } });", 3, (f, world) => {
      if (f === 3) world.pokes.push([0, 0]);
    });
    void owners;
    expect(got.lines).toEqual([]);
    expect(got.sent).toEqual([]);
  });

  it("a second program that reads the players' input reads the first one's cells: nothing of the input's is renamed a run", () => {
    // (Every input id is the map's, as the events' `@ev.` are. Renamed `@in.pressed#1` for the second run, that run read
    // cells of its own that no pass wrote: the slice 4 probe's typed lines and per-player keys heard nothing, 2026-10-24.)
    const r = compileScript(ts, { "main.ts": [
      'program(async () => { while (true) { if (keyPressed(P1, "F7")) print("one"); await nextFrame(); } });',
      'program(async () => { while (true) { if (keyPressed(P1, "F8")) print("two"); if (chatted(P1, "-help")) print("help"); await nextFrame(); } });',
    ].join("\n") }, defaultScriptNames(), { lib: defaultLib() });
    expect(r.diagnostics).toEqual([]);
    const o = emitOwn(r, { slots: [0, 1], forces: [0, 1, 0, 0, 0, 0, 0, 0] }, 1, { humans: [0, 1], width: 64 * 32, height: 64 * 32, cuwp: 64 });
    if (typeof o === "string") throw new Error(o);
    expect(o.runs).toHaveLength(2);
    expect(JSON.stringify(o.runs[1].graph).match(/"@in\.[^"#]*#[^"]*"/g) ?? []).toEqual([]);
    expect((o.runs[1].graph.cells ?? []).map((c) => c.id)).toEqual(expect.arrayContaining(["@in.pressed", "@in.chatf"]));
  });

  it("a key that reads up for one frame of a hold stays held: no second press", () => {
    const got = run([
      "program(async () => {",
      "  let held = 0;",
      "  while (true) {",
      "    if (keyPressed(P1, \"F7\")) print(`pressed after ${held}`);",
      "    if (keyHeld(P1, \"F7\")) held += 1;",
      "    await nextFrame();",
      "  }",
      "});",
    ].join("\n"), 16, (f, world) => {
      if (f === 2) world.keys.set(vk("F7"), 1);
      if (f === 6) world.keys.set(vk("F7"), 0);
      if (f === 7) world.keys.set(vk("F7"), 1);
      if (f === 10) world.keys.set(vk("F7"), 0);
      if (f === 11) world.keys.set(vk("F7"), 0);
      if (f === 12) world.keys.set(vk("F7"), 1);
    });
    // (Down 2–5, up for 6 alone, down 7–9, up 10–11, down from 12: one gap passed over, the two-frame one a release.)
    expect(got.sent.filter((s) => s.includes("move"))).toEqual(["2 move 5,1", "11 move 1,1", "12 move 5,1"]);
    expect(got.lines).toEqual(["4 pressed after 0", "14 pressed after 9"]);
  });

  it("sends a key the frame it goes down and the frame it comes up, and the press arrives two frames on", () => {
    const got = run([
      "program(async () => {",
      "  let held = 0;",
      "  while (true) {",
      "    if (keyPressed(P1, \"F7\")) print(\"pressed\");",
      "    if (keyHeld(P1, \"F7\")) held += 1;",
      "    if (keyPressed(P1, \"Space\")) print(`space ${held}`);",
      "    await nextFrame();",
      "  }",
      "});",
    ].join("\n"), 14, (f, world) => {
      if (f === 3) world.keys.set(vk("F7"), 1);
      if (f === 6) world.keys.set(vk("F7"), 0);
      if (f === 9) world.keys.set(vk("Space"), 1);
      if (f === 10) world.keys.set(vk("Space"), 0);
    });
    // (The ring's carriers in the order Player 12's list holds them: the last given first.)
    // (A release goes a frame late: a bit up the two frames before is kept through one frame it reads down.)
    expect(got.sent).toEqual(["3 select 1605", "3 move 5,1", "3 select ", "7 select 1604", "7 move 1,1", "7 select ", "9 select 1603", "9 move 9,1", "9 select ", "10 select 1602", "10 move 1,1", "10 select "]);
    expect(got.lines).toEqual(["5 pressed", "11 space 4"]);
  });
});

describe("a map of our own, input: the mouse, clicks, sync() and a program for every player", () => {
  // (The world and the game's side as in the describe above.)
  const TABLE = 0x59cca8, place = (k: number) => TABLE + 336 * k;
  const LOCAL = 0x512684, QUEUE = 0x654880, QUEUED = 0x654aa0, QUEUE_MOST = 0x57f0d8, FIRST_UNIT = 0x6283f8, KEYS = 0x596a18, BUTTONS = 0x6cddc0, MOUSE = 0x6cddc4, SCREEN_X = 0x62848c, SCREEN_Y = 0x6284a8, SELECTION = 0x6284b8;
  type World = { keys: Map<number, number>; buttons: number; mouse: [number, number]; screen: [number, number]; selection: number[]; camera: [number, number]; typed: string[] };
  const run = (script: string, frames: number, then: (frame: number, world: World) => void, mouse = false, runIndex = 0): { lines: string[]; sent: string[] } => {
    const r = compileScript(ts, { "main.ts": script }, defaultScriptNames(), { lib: defaultLib() });
    expect(r.diagnostics).toEqual([]);
    const o = emitOwn(r, { slots: [0, 1], forces: [0, 1, 0, 0, 0, 0, 0, 0] }, 1, { humans: [0, 1], width: 64 * 32, height: 64 * 32, cuwp: 64 });
    if (typeof o === "string") throw new Error(o);
    const memory = new Map<number, number>();
    memory.set(LOCAL, 0);
    memory.set(QUEUE_MOST, 496);
    // (Players 1 and 2 people in the game: the game's player type 2, a trigger list that is not empty.)
    memory.set(0x57f1b4, 2 | (2 << 8));
    for (const p of [0, 1]) memory.set(0x51a280 + 12 * p + 8, 1);
    // (The local player's name, "oracle" as the lifted game's; the text lines' ring, as 1.16.1 keeps it: the next slot's byte at
    // 0x640B58, 10 to begin with and wrapping at 11, a line shown as "name:\x07 text".)
    const NAME_AT = 0x57eeeb, TEXT_RING = 0x640b58, TEXT_LINES = 0x640b60;
    const text = new Uint8Array(13 * 218 + 4);
    const dwords = (base: number, bytes: Uint8Array, from: number, to: number, w: (a: number, v: number) => void) => {
      for (let a = from & ~3; a < to; a += 4) w(base + a, (bytes[a] | (bytes[a + 1] << 8) | (bytes[a + 2] << 16) | (bytes[a + 3] << 24)) >>> 0);
    };
    const name = Buffer.from("oracle\0", "latin1");
    const table = new Uint8Array(8 + name.length + 4);
    table.set(name, NAME_AT - (NAME_AT & ~3));
    dwords(NAME_AT & ~3, table, 0, table.length, (a, v) => memory.set(a, v));
    let ring = 10;
    memory.set(TEXT_RING, ring);
    const perHuman = (mouse ? 12 : 6);
    const pools = new Map<number, number[]>([[0, []], [1, []]]);
    let next = 1600;
    for (const h of [0, 1]) for (let i = 0; i < perHuman; i++) {
      const k = next++;
      memory.set(place(k) + 0x0c, 0x700000 + k); memory.set(place(k) + 0x4c, 3 * 256 + h); memory.set(place(k) + 0x64, 58); memory.set(place(k) + 0xa4, (i + 1) * 256);
      pools.get(h)!.push(k);
    }
    GAME.action = (kind, field, rd, w) => {
      if (kind !== 48) return;
      const h = field(16), count = field(27);
      for (let i = 0; i < count; i++) { const k = pools.get(h)!.shift()!; w(place(k) + 0x6c, rd(FIRST_UNIT + 11 * 4)); w(place(k) + 0x4c, 3 * 256 + 11); w(FIRST_UNIT + 11 * 4, place(k)); }
    };
    const world: World = { keys: new Map(), buttons: 0, mouse: [0, 0], screen: [0, 0], selection: [], camera: [0, 0], typed: [] };
    const sent: string[] = [];
    const due = new Map<number, { slot: number; x: number; y: number }[]>();
    PRINTED.got = [];
    const runs = o.runs.map((run) => ({ graph: run.graph, owner: run.player }));
    runOwn(o.runs[runIndex].graph, memory, o.values, runs.length > 1 ? runs : undefined, frames, (f, w, rd) => {
      const n = rd(QUEUED);
      const bytes: number[] = [];
      for (let a = QUEUE; a < QUEUE + n; a += 4) { const d = rd(a); bytes.push(d & 0xff, (d >> 8) & 0xff, (d >> 16) & 0xff, (d >>> 24) & 0xff); }
      bytes.length = n;
      let selected: number[] = [];
      for (let i = 0; i < bytes.length;) {
        const c = bytes[i];
        if (c === 0x05) { i++; continue; }
        if (c === 0x09) { const count = bytes[i + 1]; selected = []; for (let t = 0; t < count; t++) selected.push((bytes[i + 2 + 2 * t] | (bytes[i + 3 + 2 * t] << 8)) & 0x7ff); sent.push(`${f - 1} select ${selected.map((t) => t - 1).join(",")}`); i += 2 + 2 * count; continue; }
        if (c === 0x15) { const x = bytes[i + 1] | (bytes[i + 2] << 8), y = bytes[i + 3] | (bytes[i + 4] << 8); sent.push(`${f - 1} move ${x},${y}`); for (const t of selected) due.set(f + 1, [...(due.get(f + 1) ?? []), { slot: t - 1, x, y }]); i += 12; continue; }
        throw new Error(`a command the test does not know: 0x${c.toString(16)} at ${i} of ${bytes.length}`);
      }
      w(QUEUED, 0);
      w(0x57f23c, f);
      for (const d of due.get(f) ?? []) w(place(d.slot) + 0x58, (d.x | (d.y << 16)) >>> 0);
      then(f, world);
      for (const line of world.typed.splice(0)) {
        const at = ring * 218, bytes = Buffer.from(`oracle:\x07 ${line}\0`, "latin1");
        text.fill(0, at, at + 218);
        text.set(bytes.subarray(0, 218), at);
        dwords(TEXT_LINES, text, at, at + 218, w);
        ring = (ring + 1) % 11;
        w(TEXT_RING, ring);
      }
      const keyWords = new Map<number, number>();
      for (const [vk, down] of world.keys) if (down) keyWords.set((KEYS + vk) & ~3, (keyWords.get((KEYS + vk) & ~3) ?? 0) | (1 << (8 * ((KEYS + vk) & 3))));
      for (let a = KEYS; a < KEYS + 256; a += 4) w(a, keyWords.get(a) ?? 0);
      w(BUTTONS, world.buttons);
      w(MOUSE, world.mouse[0]); w(MOUSE + 4, world.mouse[1]); w(SCREEN_X, world.screen[0]); w(SCREEN_Y, world.screen[1]);
      for (let i = 0; i < 12; i++) w(SELECTION + 4 * i, world.selection[i] !== undefined ? place(world.selection[i]) : 0);
    });
    return { lines: PRINTED.got.map((t, i) => `${PRINTED.frames[i]} ${Buffer.from(t, "hex").toString()}`), sent };
  };

  it("sends the mouse when it moves, on its own ring, and mouse() reads it two frames on", () => {
    const got = run([
      "program(async () => {",
      "  while (true) {",
      "    const at = mouse(P1);",
      "    if (at.x || at.y) print(`${at.x},${at.y}`);",
      "    await nextFrame();",
      "  }",
      "});",
    ].join("\n"), 9, (f, world) => {
      if (f === 2) { world.screen = [100, 200]; world.mouse = [30, 40]; }
      if (f === 4) world.mouse = [31, 40];
      if (f === 6) world.screen = [100, 2100];
    }, true);
    expect(got.sent.map((s) => s.replace(/select .*/, "select"))).toEqual(["2 select", "2 move 130,240", "2 select", "4 select", "4 move 131,240", "4 select", "6 select", "6 move 131,2014", "6 select"]);
    expect(got.lines).toEqual(["4 130,240", "5 130,240", "6 131,240", "7 131,240", "8 131,2014", "9 131,2014"]);
  });

  it("a click is the frame the button went down", () => {
    const got = run([
      "program(async () => {",
      "  while (true) {",
      "    if (clicked(P1)) print(\"left\");",
      "    if (clicked(P1, \"right\")) print(\"right\");",
      "    await nextFrame();",
      "  }",
      "});",
    ].join("\n"), 10, (f, world) => {
      if (f === 2) world.buttons = 2;
      if (f === 5) world.buttons = 0;
      if (f === 6) world.buttons = 8;
      if (f === 7) world.buttons = 0;
    });
    expect(got.lines).toEqual(["4 left", "8 right"]);
  });

  it("sync() sends the value from the player's computer and resolves two frames on, everywhere", () => {
    const got = run([
      "program(async () => {",
      "  const before = memory.game.frame;",
      "  const x = await sync(P1, local.camera.x + 7);",
      "  print(`got ${x} after ${memory.game.frame - before}`);",
      "  const [a, b] = await sync(P1, 1000000, 5);",
      "  print(`${a} ${b}`);",
      "});",
    ].join("\n"), 12, (f, world) => { if (f === 1) world.screen = [300, 0]; });
    expect(got.lines).toEqual(["3 got 307 after 2", "5 1000000 5"]);
  });

  it("a program for every player reads each player's own keys", () => {
    const got = run([
      "program(async () => {",
      "  while (true) {",
      "    if (keyPressed(CurrentPlayer, \"Space\")) print(\"jump\");",
      "    await nextFrame();",
      "  }",
      "}, { owner: AllPlayers });",
    ].join("\n"), 8, (f, world) => {
      if (f === 2) world.keys.set(virtualKey("Space")!, 1);
      if (f === 3) world.keys.set(virtualKey("Space")!, 0);
    });
    expect(got.lines).toEqual(["4 jump"]);
  });

  it("a typed line is matched where it was typed and arrives as its pattern and values, two frames on", () => {
    const got = run([
      "program(async () => {",
      "  on.chat(\"-ping {n}\", (p, { n }) => { print(`ping ${n}`); });",
      "  while (true) {",
      "    if (chatted(P1, \"-help\")) print(\"help\");",
      "    const g = chatted(P1, \"-give {n} {what:ore|gas}\");",
      "    if (g) print(`give ${g.n} ${g.what}`);",
      "    const s = chatted(P1, \"-spawn {what:unit}\");",
      "    if (s) print(`spawn ${s.what}` + (s.what == units.TerranMarine ? \" (a marine)\" : \"\"));",
      "    await nextFrame();",
      "  }",
      "});",
    ].join("\n"), 32, (f, world) => {
      // (A line a frame at the most: a person types one at a time, and the map keeps one matched line until it has gone.)
      if (f === 2) world.typed.push("-help");
      if (f === 4) world.typed.push("-give 5000 gas");
      if (f === 6) world.typed.push("hello there", "-spawn Terran Marine");
      if (f === 8) world.typed.push("-give x ore", "-give 99999999 ORE");
      if (f === 10) world.typed.push("-spawn nothing of the kind");
      if (f === 12) world.typed.push("-spawn zerg zergling");
      if (f === 13) world.typed.push("-ping 7");
      // (Thirteen more lines: the ring goes round, and a line dealt with is not dealt with again.)
      if (f >= 14 && f <= 26) world.typed.push("-help");
      if (f === 28) world.typed.push("-help");
    });
    // (A header is the pattern's number, in the order the programs are read: on.chat's first. A point is the value plus
    // one in each of x and y: "-give 5000 gas" is 2 + 4 × 3, then 5000 — x 905, y 5 on a map 64 tiles wide — then gas, 1.)
    expect(got.sent.filter((s) => s.includes("move")).slice(0, 6)).toEqual(["2 move 11,1", "4 move 15,1", "4 move 905,5", "4 move 2,1", "6 move 19,1", "6 move 1,1"]);
    expect(got.lines).toEqual([
      "4 help", "6 give 5000 1", "8 spawn 0 (a marine)", "10 give 1048575 0", "14 spawn 37", "15 ping 7",
      ...Array.from({ length: 13 }, (_, i) => `${16 + i} help`), "30 help",
    ]);
  });
});

describe("a map of our own, the tasks' turn while the program sleeps", () => {
  const laid = (script: string) => {
    const r = compileScript(ts, { "main.ts": script }, defaultScriptNames(), { lib: defaultLib() });
    expect(r.diagnostics).toEqual([]);
    const o = emitOwn(r, { slots: [0, 1], forces: [0, 1, 0, 0, 0, 0, 0, 0] }, 1, { humans: [0], width: 64 * 32, height: 64 * 32, cuwp: 64 });
    if (typeof o === "string") throw new Error(o);
    return layout({ runs: o.runs.map((run) => ({ graph: run.graph, owner: run.player })), strings: 0, text: () => 1, arrays: o.values, template: () => 1 });
  };
  it("sets the current player to the owner before the wake of a run with tasks, and not where there are none", () => {
    // (The walk runs from the last player's list, the current player theirs; the wake sets the owner only when the
    // program runs, and a task's turn comes while it sleeps too: what the task showed then, the owner did not see.
    // The first play of the events probe, 2026-10-24: "back", printed by a task two seconds after a death.)
    const withTask = laid("program(async () => { async function later() { await sleep(frames(48)); print(\"later\"); } void later(); await sleep(frames(200)); });");
    expect(withTask.triggers.has("@cur")).toBe(true);
    expect(withTask.triggers.has("@wake")).toBe(true);
    const without = laid("program(async () => { print(\"now\"); await sleep(frames(200)); });");
    expect(without.triggers.has("@cur")).toBe(false);
  });
});
