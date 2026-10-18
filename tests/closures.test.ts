/**
 * TrigScript 4: closures over locals. A function kept as a value that uses a variable of the function or the block it
 * was written in keeps that variable in an environment, one for each run of the block, as JavaScript does; what holds
 * a closure is counted, and an environment nothing holds is given back at the next wait. The bodies are run in
 * JavaScript too, and compared.
 */
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { compileScript, type CompileResult } from "../compiler/compiler";
import { defaultScriptNames } from "../compiler/names";
import { simulatePrograms } from "../compiler/simulateIr";
import { defaultLib } from "../bundle/lib.mjs";

const LIB = defaultLib();
const NAMES = defaultScriptNames();
const raw = (body: string): CompileResult => compileScript(ts, { "main.ts": `program(async () => {${body}});` }, NAMES, { lib: LIB });
const compile = (body: string): CompileResult => { const r = raw(body); expect(r.diagnostics.map((d) => d.message)).toEqual([]); return r; };
const run = (body: string, frames = 1) => { const r = compile(body); return simulatePrograms(r.ir, frames, { strings: r.strings }); };
const messages = (body: string) => raw(body).diagnostics.map((d) => d.message);
const shown = (sim: ReturnType<typeof run>) => sim.events.map((e) => e.text);
/** What JavaScript itself says of the same lines: the body is run as it is, `print` collecting. */
const js = (body: string): string[] => { const out: string[] = []; new Function("print", ts.transpile(body, { target: ts.ScriptTarget.ES2023 }))((t: string) => out.push(t)); return out; };
const same = (body: string) => { const sim = run(body); expect(sim.faults).toEqual([]); expect(shown(sim)).toEqual(js(body)); };

describe("a closure over a variable of its function", () => {
  it("makeCounter: each counter its own count, kept after make returns", () => {
    same("function makeCounter() { let count = 0; return () => { count++; return count; }; } let a = makeCounter(); let b = makeCounter(); a(); a(); b(); print(`${a()} ${b()}`);");
  });
  it("a parameter kept: adder(k) made from a number worked out in the game", () => {
    same("function adder(k: number) { return (x: number) => x + k; } let n = 2; const fs: ((x: number) => number)[] = []; while (n < 5) { fs.push(adder(n * 10)); n++; } let t = 0; for (const f of fs) t = t * 1000 + f(1); print(`${t}`);");
  });
  it("the function and its closure share the variable: a write either side is seen by the other", () => {
    same("function pair() { let x = 1; const bump = () => { x += 10; }; bump(); x += 100; let get = () => x; bump(); return get; } let g = pair(); print(`${g()}`);");
  });
  it("two closures of one run share its variables: { inc, get }", () => {
    same("function counter() { let c = 0; return { inc: () => { c++; }, get: () => c }; } const { inc, get } = counter(); const other = counter(); inc(); inc(); other.inc(); other.inc(); other.inc(); print(`${get()} ${other.get()}`);");
  });
  it("a copy of a closure is the same closure", () => {
    same("function makeCounter() { let count = 0; return () => ++count; } let a = makeCounter(); let b = a; a(); b(); print(`${a()} ${a === b ? 'same' : 'other'}`);");
  });
  it("a boolean, a unit-free text and a fixed number kept", () => {
    same("function make(label: string, start: boolean) { let on = start; let s = label; return () => { on = !on; s = s + (on ? '+' : '-'); return s; }; } let f = make('a', false); f(); f(); print(f());");
  });
});

describe("a closure over a variable of a loop", () => {
  it("a const of a while loop's body: one for each turn", () => {
    same("const hs: (() => number)[] = []; let n = 0; let k = 4; while (n < k) { const sq = n * n; hs.push(() => sq); n++; } let t = 0; for (const h of hs) t = t * 100 + h(); print(`${t}`);");
  });
  it("the let of a for, one for each turn as JavaScript has it", () => {
    same("const hs: (() => number)[] = []; let n = 3; for (let i = 0; i < n; i++) hs.push(() => i); let t = 0; for (const h of hs) t = t * 10 + h(); print(`${t}`);");
  });
  it("the let of a for changed in the body is seen by that turn's closures, and the update counts on from it", () => {
    same("const hs: (() => number)[] = []; let n = 9; for (let i = 0; i < n; i++) { hs.push(() => i); i += 2; } let t = 0; for (const h of hs) t = t * 10 + h(); print(`${t}`);");
  });
  it("a for…of over an array that grows", () => {
    same("const xs: number[] = []; xs.push(3); xs.push(5); xs.push(7); const hs: (() => number)[] = []; for (const x of xs) hs.push(() => x * 2); let t = 0; for (const h of hs) t = t * 100 + h(); print(`${t}`);");
  });
});

describe("closures inside closures", () => {
  it("a closure made by a closure reaches both", () => {
    same("function outer(a: number) { return (b: number) => (c: number) => a * 100 + b * 10 + c; } let k = 1; let f = outer(k); let g = f(2); print(`${g(3)} ${f(4)(5)}`);");
  });
  it("a kept function's own variable kept by the closure it makes", () => {
    same("let make: () => () => number = () => { let n = 5; return () => ++n; }; let a = make(); let b = make(); a(); print(`${a()} ${b()}`);");
  });
  it("calls a function written beside the variable it uses", () => {
    same("function make() { let c = 0; const inc = () => { c += 3; }; return () => { inc(); return c; }; } let f = make(); f(); print(`${f()}`);");
  });
});

describe("what holds a closure", () => {
  it("a field of a record, a Map's value and a class's field", () => {
    same("function tag(n: number) { return () => n; } const m = new Map<number, () => number>(); let k = 4; m.set(1, tag(k)); m.set(2, tag(k + 1)); const r = { f: tag(k + 2) }; let t = m.get(1)!() * 100 + m.get(2)!() * 10 + r.f(); print(`${t}`);");
  });
  it("handlers registered in a loop and fired later, frames apart", () => {
    const sim = run("const hs: ((x: number) => void)[] = []; let log = 0; let i = 0; while (i < 3) { const w = i + 1; hs.push((x) => { log = log * 10 + w * x; }); i++; } await sleep(frames(2)); for (const h of hs) h(2); print(`${log}`);", 5);
    expect(sim.faults).toEqual([]);
    expect(shown(sim)).toEqual(["246"]);
  });
});

describe("a function handed to a task", () => {
  it("keeps what it uses of a loop's turn, each task its own, as JavaScript's setInterval callbacks do", () => {
    const r = compileScript(ts, { "main.ts": "const tick = game(async (period: number, fn: () => void) => { while (true) { await sleep(frames(period)); fn(); } }); const every = game((period: number, fn: () => void): Task => start(tick(period, fn))); program(async () => { let log = ''; let k = 1; while (k <= 3) { const tag = k * 10; every(4, () => { log += `${tag} `; }); k++; } await sleep(frames(6)); print(log); });" }, NAMES, { lib: LIB });
    expect(r.diagnostics.map((d) => d.message)).toEqual([]);
    const sim = simulatePrograms(r.ir, 8, { strings: r.strings });
    expect(sim.faults).toEqual([]);
    expect(shown(sim)).toEqual(["10 20 30 "]);
  });
});

describe("environments are given back", () => {
  it("thousands made over many frames, each let go of, never run out", () => {
    const sim = run("let total = 0; let f: () => number = () => 0; let n = 0; while (n < 3000) { const k = n; f = () => k; total += f(); n++; if (n % 100 == 0) await sleep(frames(1)); } print(`${total}`);", 40);
    expect(sim.faults).toEqual([]);
    expect(shown(sim)).toEqual([`${(2999 * 3000) / 2}`]);
  });
  it("kept ones stay while others come and go", () => {
    const sim = run("const keep: (() => number)[] = []; let n = 0; let f: () => number = () => 0; while (n < 2000) { const k = n; f = () => k; if (n % 500 == 0) keep.push(f); n++; if (n % 50 == 0) await sleep(frames(1)); } let t = 0; for (const h of keep) t += h(); print(`${t}`);", 60);
    expect(sim.faults).toEqual([]);
    expect(shown(sim)).toEqual([`${0 + 500 + 1000 + 1500}`]);
  });
  it("too many at once in one frame: said once, and the new one does nothing", () => {
    const sim = run("const keep: (() => number)[] = []; let n = 0; while (n < 1100) { const k = n; keep.push(() => k); n++; } print(`${keep.length}`);", 2);
    expect(sim.faults).toEqual([]);
    expect(shown(sim).some((t) => /more than 1023 closures/.test(t ?? ""))).toBe(true);
  });
});

describe("what a closure may not keep yet", () => {
  it("a variable of a function that calls itself", () => {
    expect(messages("const hs: (() => number)[] = []; function walk(n: number) { if (n <= 0) return; const m = n; hs.push(() => m); walk(n - 1); } let k = 3; walk(k);").join("\n")).toMatch(/calls itself/);
  });
  it("an array of the function", () => {
    expect(messages("function make() { const xs = [1, 2]; xs[0] = 5; return () => xs[0]; } let f = make(); let n = 0; n = f();").join("\n")).toMatch(/uses xs/);
  });
});
