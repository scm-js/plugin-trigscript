/**
 * TrigScript 4, B3: functions as values. A function handed down (`twice(() => …)`), kept in a const or a parameter, is
 * known when the script is built and its calls are calls of its body; one kept in a variable, an array, a field or a Map
 * is a number, and a call through it goes through a dispatcher that runs the function with that number. The bodies are
 * run in JavaScript too, and compared.
 */
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { compileScript, type CompileResult } from "../compiler/compiler";
import { defaultScriptNames } from "../compiler/names";
import { simulatePrograms } from "../compiler/simulateIr";
import { defaultLib } from "../bundle/lib.mjs";

const LIB = defaultLib();
const NAMES = defaultScriptNames();
const raw = (body: string): CompileResult => compileScript(ts, { "main.ts": `program(() => {${body}});` }, NAMES, { lib: LIB });
const compile = (body: string): CompileResult => { const r = raw(body); expect(r.diagnostics.map((d) => d.message)).toEqual([]); return r; };
const run = (body: string) => { const r = compile(body); return simulatePrograms(r.ir, 1, { strings: r.strings }); };
const messages = (body: string) => raw(body).diagnostics.map((d) => d.message);
const shown = (sim: ReturnType<typeof run>) => sim.events.map((e) => e.text);
/** What JavaScript itself says of the same lines: the body is run as it is, `print` collecting. */
const js = (body: string): string[] => { const out: string[] = []; new Function("print", ts.transpile(body, { target: ts.ScriptTarget.ES2023 }))((t: string) => out.push(t)); return out; };
const same = (body: string) => { const sim = run(body); expect(sim.faults).toEqual([]); expect(shown(sim)).toEqual(js(body)); };
/** The functions of the built program: what is called, and the dispatchers. */
const functions = (body: string) => compile(body).ir[0].functions ?? [];

describe("a function handed down", () => {
  it("an arrow given to a parameter is called where the parameter is", () => {
    same("let n = 0; function twice(f: () => void) { f(); f(); } twice(() => { n++; }); twice(() => { n += 10; }); print(`${n}`);");
  });
  it("with arguments and a result, and a variable of the program's as the argument", () => {
    same("function apply(f: (x: number) => number, v: number) { return f(f(v)); } let k = 2; let a = 0; a = apply((x) => x * 3, k); a = apply((x) => x + 1, a); print(`${a}`);");
  });
  it("a declared function by its name, a const holding one, and a function used as forEach's", () => {
    same("let total = 0; function add(x: number) { total += x; } const sub = (x: number) => { total -= x; }; function each(xs: number[], f: (x: number) => void) { for (const x of xs) f(x); } let xs = [1, 2, 3]; each(xs, add); each(xs, add); each([5], sub); xs.forEach(sub); print(`${total}`);");
  });
  it("sees the variables where it was written, a function's own included", () => {
    same("function count(xs: number[], test: (x: number) => boolean) { let n = 0; for (const x of xs) if (test(x)) n++; return n; } function above(xs: number[], floor: number) { return count(xs, (x) => x > floor); } let xs = [3, 8, 1, 9, 4]; let lo = 3; print(`${above(xs, lo)} ${above(xs, 8)} ${count(xs, (x) => x % 2 == 0)}`);");
  });
  it("a function called from several places is one copy for each function it is handed", () => {
    const fs = functions("let n = 0; function twice(f: () => void) { f(); f(); } function inc() { n++; } function dec() { n--; } twice(inc); twice(inc); twice(dec); twice(dec); twice(inc);");
    expect(fs.filter((f) => f.name === "twice")).toHaveLength(2);
  });
  it("an optional one left out is undefined: ?.() does nothing and if (f) is false", () => {
    same("let n = 0; function run(g?: () => void) { g?.(); if (g) n += 10; } run(); run(() => { n++; }); print(`${n}`);");
  });
});

describe("a function kept in a variable", () => {
  it("is given another function, and a call runs whichever it holds now", () => {
    same("let f = (x: number) => x + 1; let n = 0; n = f(2); f = (x: number) => x * 10; n = f(n); print(`${n}`);");
  });
  it("a state machine: each state is a function, and gives the next", () => {
    same("let ticks = 0; let state: () => void = idle; function idle() { ticks++; if (ticks == 3) state = busy; } function busy() { ticks += 10; if (ticks > 20) state = idle; } let i = 0; while (i < 6) { state(); i++; } print(`${ticks}`);");
  });
  it("undefined until it is set: ?.() and a test of it", () => {
    same("let n = 0; let f = undefined as (() => void) | undefined; function fire() { f?.(); } fire(); f = () => { n++; }; fire(); fire(); function set() { return f !== undefined; } if (set()) n += 100; print(`${n}`);");
  });
  it("chosen with ?:, and called where it is chosen", () => {
    same("function inc(x: number) { return x + 1; } function dbl(x: number) { return x * 2; } let k = 5; let up = true; let a = 0; a = (up ? inc : dbl)(k); up = false; a += (up ? inc : dbl)(k); print(`${a}`);");
  });
  it("calls itself through the variable", () => {
    same("let fact: (n: number) => number = (n) => (n <= 1 ? 1 : n * fact(n - 1)); let k = 6; print(`${fact(k)}`);");
  });
  it("returns a text, a boolean or nothing", () => {
    same("let name: (n: number) => string = (n) => `#${n}`; let even: (n: number) => boolean = (n) => n % 2 == 0; let k = 4; let log = ''; let say: (s: string) => void = (s) => { log += s; }; say(name(k)); if (even(k)) say('!'); print(log);");
  });
});

describe("functions in arrays, fields and Maps", () => {
  it("an array of functions, called by a place worked out in the game", () => {
    same("function a() { return 1; } function b() { return 2; } function c() { return 3; } const fs = [a, b, c]; let sum = 0; for (let i = 0; i < 3; i++) sum = sum * 10 + fs[(i + 1) % 3](); print(`${sum}`);");
  });
  it("handlers pushed to an array and all called", () => {
    same("let log = 0; const handlers: ((n: number) => void)[] = []; function on(h: (n: number) => void) { handlers.push(h); } on((n) => { log += n; }); on((n) => { log += n * 100; }); for (const h of handlers) h(3); handlers.pop(); handlers.forEach((h) => h(1)); print(`${log}`);");
  });
  it("a record of functions, and a field given another one", () => {
    same("const ops = { add: (a: number, b: number) => a + b, mul: (a: number, b: number) => a * b }; let n = 0; n = ops.add(2, 3); n = ops.mul(n, 4); ops.add = (a: number, b: number) => a - b; n = ops.add(n, 1); print(`${n}`);");
  });
  it("a class whose field is a function, set from outside, and this in an arrow field", () => {
    same("class Btn { clicks = 0; onClick: () => void = () => {}; label = () => `${this.clicks} clicks`; click() { this.clicks++; this.onClick(); } } let k = 0; const b = new Btn(); b.click(); b.onClick = () => { k += 5; }; b.click(); b.click(); print(`${k} ${b.label()}`);");
  });
  it("a Map from numbers to functions", () => {
    same("function hi() { return 1; } function lo() { return 2; } const byKey = new Map<number, () => number>(); byKey.set(7, hi); byKey.set(9, lo); let k = 9; let n = 0; const f = byKey.get(k); if (f) n = f(); n = n * 10 + byKey.get(7)!(); print(`${n}`);");
  });
});

describe("a function that makes a function", () => {
  it("of values known when the script is built: one function for each", () => {
    same("function adder(k: number) { return (x: number) => x + k; } const add3 = adder(3); let n = 1; n = add3(n); let f = adder(10); n = f(n); print(`${n}`);");
  });
  it("compose: a function of the functions it was handed", () => {
    same("function compose(f: (x: number) => number, g: (x: number) => number) { return (x: number) => f(g(x)); } const inc = (x: number) => x + 1; const dbl = (x: number) => x * 2; let h = compose(inc, dbl); let k = 5; let a = h(k); h = compose(dbl, inc); a = a * 100 + h(k); print(`${a}`);");
  });
  it("chooses one of the program's in the game", () => {
    same("function inc(x: number) { return x + 1; } function dbl(x: number) { return x * 2; } function pick(n: number): (x: number) => number { if (n > 0) return inc; return dbl; } let k = 1; let a = pick(k)(7); k = 0; a = a * 100 + pick(k)(7); print(`${a}`);");
  });
});

describe("what a function kept as a value may do, and not", () => {
  it("keep a variable of the function it was written in: since closures, it keeps one (tests/closures.test.ts)", () => {
    same("function make() { let local = 5; local++; return () => local; } let f = make(); let n = 0; n = f(); print(`${n}`);");
  });
  it("keep a variable of a loop: since closures, one for each turn", () => {
    same("const hs: (() => number)[] = []; let n = 3; for (let i = 0; i < n; i++) hs.push(() => i); let t = 0; for (const h of hs) t = t * 10 + h(); print(`${t}`);");
  });
  it("but a loop with bounds known when the script is built is unrolled, and each function has its own i", () => {
    same("const hs: (() => number)[] = []; for (let i = 0; i < 3; i++) hs.push(() => i * 10); let t = 0; for (const h of hs) t += h(); print(`${t}`);");
  });
  it("be async, or take an array", () => {
    expect(messages("let f: () => Promise<void> = async () => { await sleep(frames(1)); }; await f();").join("\n")).toMatch(/async/);
    expect(messages("let f = (xs: number[]) => xs.length; let n = 0; n = f([1]);").join("\n")).toMatch(/its parameters are numbers, booleans, texts, units or other functions/);
  });
});
