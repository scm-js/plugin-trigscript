/**
 * TrigScript 4: functions from any file. A function declared at the top of a script's file — or a `const` arrow there —
 * is called by a program with the program's own values, as a `game()` function is, without the wrapper; called with
 * values the script knows, it still runs when the script is built. The same as classes from any file.
 */
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { compileScript, type CompileResult } from "../compiler/compiler";
import { defaultScriptNames } from "../compiler/names";
import { simulatePrograms } from "../compiler/simulateIr";
import { defaultLib } from "../bundle/lib.mjs";

const LIB = defaultLib();
const NAMES = defaultScriptNames();
const raw = (files: Record<string, string>): CompileResult => compileScript(ts, files, NAMES, { lib: LIB });
const compile = (files: Record<string, string>): CompileResult => { const r = raw(files); expect(r.diagnostics.map((d) => `${d.file}:${d.line}: ${d.message}`)).toEqual([]); return r; };
const shown = (files: Record<string, string>) => { const r = compile(files); const sim = simulatePrograms(r.ir, 1, { strings: r.strings }); expect(sim.faults).toEqual([]); return sim.events.map((e) => e.text); };

describe("functions from any file", () => {
  it("a declared function and a const arrow at the top of the file, called with the program's values", () => {
    expect(shown({ "main.ts": "function double(n: number) { return n * 2; } const inc = (n: number) => n + 1; program(() => { let k = 5; k = inc(double(k)); print(`${k}`); });" })).toEqual(["11"]);
  });
  it("from another file, imported", () => {
    expect(shown({
      "main.ts": "import { clampHp, label } from './util'; program(() => { let hp = 120; hp = clampHp(hp, 100); print(label('hp', hp)); });",
      "util.ts": "export function clampHp(hp: number, max: number) { return hp > max ? max : hp; } export function label(name: string, n: number) { return `${name}=${n}`; }",
    })).toEqual(["hp=100"]);
  });
  it("called with values the script knows, it runs when the script is built: whatever JavaScript it uses", () => {
    const r = compile({ "main.ts": "function table(n: number) { return Array.from({ length: n }, (_, i) => i * i).join(','); } program(() => { print(table(4)); });" });
    expect(simulatePrograms(r.ir, 1, { strings: r.strings }).events.map((e) => e.text)).toEqual(["0,1,4,9"]);
  });
  it("kept as a value and called through it", () => {
    expect(shown({ "main.ts": "function a() { return 1; } function b() { return 2; } program(() => { const fs = [a, b]; let k = 1; print(`${fs[k]() * 10 + fs[0]()}`); });" })).toEqual(["21"]);
  });
  it("a function at the top that takes its arguments apart", () => {
    expect(shown({ "main.ts": "function area({ w, h }: { w: number; h: number }) { return w * h; } program(() => { let k = 3; print(`${area({ w: k, h: k + 1 })}`); });" })).toEqual(["12"]);
  });
  it("its errors are said where a program calls it with its own values, not when it is only used when the script is built", () => {
    expect(raw({ "main.ts": "function bad(n: number) { return [n].map((x) => `${x}`).join(); } const ok = bad(3); program(() => { print(ok); });" }).diagnostics).toEqual([]);
  });
});

describe("a function that keeps a state", () => {
  // Worked out when the script was built, a call changed the state once where it was written: a loop printed 1, 1, 1.
  const COUNTER = "function counter() { let n = 0; return () => { n += 1; return n; }; }";
  const loop = (call: string) => `program(() => { let k = 0; while (k < 3) { print(\`\${${call}}\`); k += 1; } });`;
  const said = (files: Record<string, string>) => raw(files).diagnostics.map((d) => `${d.line}: ${d.message}`);

  it("a closure made in the program runs in the game, each call its own", () => {
    expect(shown({ "main.ts": `${COUNTER}\nprogram(() => { const next = counter(); let k = 0; while (k < 3) { print(\`\${next()}\`); k += 1; } });` })).toEqual(["1", "2", "3"]);
  });

  it("one made when the script was built, or a method of an instance made then, is refused: the game cannot change what they keep", () => {
    expect(said({ "main.ts": `${COUNTER}\nconst next = counter();\n${loop("next()")}` })).toEqual([
      "3: next() changes what it keeps between calls, but that was made when the script was built, where the game cannot change it. Make it inside the program, or keep what changes in a let of the program.",
    ]);
    expect(said({ "main.ts": `class Counter { n = 0; inc() { this.n += 1; return this.n; } }\nconst c = new Counter();\n${loop("c.inc()")}` })[0]).toMatch(/^3: c\.inc\(\) changes what it keeps between calls/);
  });

  it("a function writing a variable or a record of the script's is the program's, and refused as the write would be — once", () => {
    expect(said({ "main.ts": `let count = 0;\nfunction bump() { count += 1; return count; }\nprogram(() => { print(\`\${bump()}\`); print(\`\${bump()}\`); });` })).toEqual(["2: Only the program's let variables can be assigned."]);
    expect(said({ "main.ts": `const box = { n: 0 };\nfunction bump() { box.n += 1; return box.n; }\n${loop("bump()")}` })[0]).toMatch(/^2: This object is computed when the script is built/);
  });

  it("what keeps no state is still worked out when the script is built: its own variables, a callback's writes to them, a cache", () => {
    const r = compile({ "main.ts": [
      "const cache = new Map<number, number>();",
      "function sq(v: number) { const had = cache.get(v); if (had !== undefined) return had; const r = v * v; cache.set(v, r); return r; }",
      "function sum(xs: number[]) { let t = 0; xs.forEach((x) => { t += x; }); return t; }",
      "class P { x = 0; constructor(x: number) { this.x = x; } }",
      "function made(x: number) { return new P(x).x; }",
      "program(() => { let k = 0; while (k < 2) { print(`${sq(7)} ${sum([1, 2, 3])} ${made(4)}`); k += 1; } });",
    ].join("\n") });
    expect(simulatePrograms(r.ir, 1, { strings: r.strings }).events.map((e) => e.text)).toEqual(["49 6 4", "49 6 4"]);
    expect(JSON.stringify(r.ir)).not.toContain("\"call\"");
  });
});
