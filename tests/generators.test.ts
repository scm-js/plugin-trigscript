/**
 * TrigScript 4: generators finished, and async functions in libraries. A for…of walks a generator where it is written —
 * the loop's body is put where each yield is — whether the generator is a function of the program, one at the top of a
 * file, a method, or an instance's `*[Symbol.iterator]()`; `yield*` walks another there too. An async function at the top
 * of a file is called and started with the program's values, and waits as one of the program's does. The bodies are run
 * in JavaScript too, and compared.
 */
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { compileScript, type CompileResult } from "../compiler/compiler";
import { defaultScriptNames } from "../compiler/names";
import { simulatePrograms } from "../compiler/simulateIr";
import { defaultLib } from "../bundle/lib.mjs";

const LIB = defaultLib();
const NAMES = defaultScriptNames();
const raw = (body: string, top = ""): CompileResult => compileScript(ts, { "main.ts": `${top}\nprogram(async () => {${body}});` }, NAMES, { lib: LIB });
const compile = (body: string, top = ""): CompileResult => { const r = raw(body, top); expect(r.diagnostics.map((d) => d.message)).toEqual([]); return r; };
const run = (body: string, top = "", frames = 1) => { const r = compile(body, top); return simulatePrograms(r.ir, frames, { strings: r.strings }); };
const shown = (sim: ReturnType<typeof run>) => sim.events.map((e) => e.text);
const js = (body: string, top = ""): string[] => { const out: string[] = []; new Function("print", ts.transpile(`${top}\n${body}`, { target: ts.ScriptTarget.ES2023 }))((t: string) => out.push(t)); return out; };
const same = (body: string, top = "") => { const sim = run(body, top); expect(sim.faults).toEqual([]); expect(shown(sim)).toEqual(js(body, top)); };

describe("a generator walked by for…of", () => {
  it("at the top of a file, handed the program's values", () => {
    same("let k = 3; let s = 0; for (const x of g(k)) s += x; print(`${s}`);", "function* g(n: number) { for (let i = 0; i < n; i++) yield i * 10; }");
  });
  it("a method of a class, this the instance", () => {
    same("class R { n = 3; *items() { for (let i = 0; i < this.n; i++) yield i; } } const r = new R(); let k = 1; r.n += k; let s = ''; for (const x of r.items()) s += x; print(s);");
  });
  it("an instance's *[Symbol.iterator]()", () => {
    same("class Squad { hps = [5, 7, 9]; *[Symbol.iterator]() { for (const h of this.hps) yield h; } } const sq = new Squad(); let t = 0; for (const h of sq) t += h; print(`${t}`);");
  });
  it("yield* of another generator and of a list; break leaves both", () => {
    same("function* a(n: number) { yield n; yield n + 1; } function* g() { yield 1; yield* a(10); yield* [7, 8]; yield 2; } let s = ''; for (const x of g()) { s += x + ','; if (x === 8) break; } print(s);");
    same("const xs = [4, 5]; function* g() { yield* xs; yield 6; } let s = 0; for (const x of g()) s = s * 10 + x; print(`${s}`);");
  });
});

describe("an async function at the top of a file", () => {
  it("awaited with the program's values, waiting frames the game holds", () => {
    const sim = run("let k = 2; const v = await walk(k); print(`${v}`);", "async function walk(n: number) { await sleep(frames(n)); return n * 2; }", 6);
    expect(shown(sim)).toEqual(["4"]);
  });
  it("started as a task", () => {
    const sim = run("let k = 2; start(blink(k)); await sleep(frames(5)); print('done');", "async function blink(times: number) { for (let i = 0; i < times; i++) { print('b'); await sleep(frames(1)); } }", 8);
    expect(shown(sim)).toEqual(["b", "b", "done"]);
  });
});

describe("sleep of a duration the game holds", () => {
  it("frames(n) and seconds(n): that many frames, the next one at the least", () => {
    const sim = run("let n = 3; print('a'); await sleep(frames(n)); print('b'); let z = 0; await sleep(frames(z)); print('c'); let t = 1; await sleep(seconds(t)); print('d');", "", 40);
    const at = sim.events.filter((e) => e.text).map((e) => `${e.cycle}:${e.text}`);
    const frameOf = (t: string) => Number(at.find((x) => x.endsWith(`:${t}`))!.split(":")[0]);
    expect(frameOf("b") - frameOf("a")).toBe(3);
    expect(frameOf("c") - frameOf("b")).toBe(1);
    expect(frameOf("d") - frameOf("c")).toBe(24);
  });
});
