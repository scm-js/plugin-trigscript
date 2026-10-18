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
