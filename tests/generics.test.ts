/**
 * TrigScript 4: generics. A generic class's instance (`new Signal<number>()`) and a generic function at a call
 * (`swap(names, 0, 1)`) are worked out with their type parameters standing for what they are there: a field of type T,
 * a parameter of type T, an array of T, a handler taking a T. Each body is run in JavaScript too, and the prints compared.
 */
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { compileScript, type CompileResult } from "../compiler/compiler";
import { defaultScriptNames } from "../compiler/names";
import { simulatePrograms } from "../compiler/simulateIr";
import { defaultLib } from "../bundle/lib.mjs";

const LIB = defaultLib();
const NAMES = defaultScriptNames();
const compile = (source: string): CompileResult => { const r = compileScript(ts, { "main.ts": source }, NAMES, { lib: LIB }); expect(r.diagnostics.map((d) => `${d.line}: ${d.message}`)).toEqual([]); return r; };
const js = (source: string): string[] => { const out: string[] = []; new Function("print", "program", ts.transpile(source, { target: ts.ScriptTarget.ES2023 }))((t: string) => out.push(t), (f: () => void) => f()); return out; };
const same = (source: string) => { const r = compile(source); const sim = simulatePrograms(r.ir, 1, { strings: r.strings }); expect(sim.faults).toEqual([]); expect(sim.events.map((e) => e.text)).toEqual(js(source)); };

describe("generic classes", () => {
  it("one class, instances of numbers and of texts, each with handlers of its own type", () => {
    same(`class Box<T> { items: T[] = []; handlers: ((v: T) => void)[] = []; put(v: T) { this.items.push(v); for (const h of this.handlers) h(v); } on(h: (v: T) => void) { this.handlers.push(h); } count(): number { return this.items.length; } }
      program(() => { const ns = new Box<number>(); const ts = new Box<string>(); let log = ""; ns.on((n) => { log += \`<\${n}>\`; }); ts.on((s) => { log += \`[\${s}]\`; }); let k = 2; ns.put(k * 3); ts.put(\`t\${k}\`); ts.put("u"); print(\`\${log} \${ns.count()} \${ts.count()}\`); });`);
  });
  it("a field of type T with a first value given to the constructor", () => {
    same(`class Cell<T> { value: T; constructor(v: T) { this.value = v; } get(): T { return this.value; } set(v: T) { this.value = v; } }
      program(() => { let k = 4; const a = new Cell<number>(k); const b = new Cell<string>("x"); a.set(a.get() + 1); b.set(b.get() + "y"); print(\`\${a.get()} \${b.get()}\`); });`);
  });
});

describe("generic functions", () => {
  it("T from an argument, T[] from an array, a T returned", () => {
    same(`function swap<T>(xs: T[], i: number, j: number) { const t = xs[i]; xs[i] = xs[j]; xs[j] = t; }
      function firstOr<T>(xs: T[], other: T): T { return xs.length > 0 ? xs[0] : other; }
      function same<T>(x: T): T { return x; }
      program(() => { let k = 2; const ns = [1, 2, 3]; swap(ns, 0, k); const ts: string[] = ["a", "b"]; swap(ts, 0, 1); print(\`\${ns.join("")} \${ts.join("")} \${firstOr(ns, -1)} \${firstOr(ts, "z")} \${same(k)} \${same(\`t\${k}\`)}\`); });`);
  });
});
