/**
 * The two faults the language sweep of 2026-10-18 found. A function narrowing its argument with `typeof` is inlined with
 * only the side its argument takes, in `c ? a : b` as in an if — a number variable was read as a text and the compiler
 * recursed until the stack ran out. And JavaScript's clock and dice (`Date.now()`, `new Date()`, `Math.random()`) were
 * worked out when the script was built, silently; inside a program they are refused now, the game's own named instead.
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
const messages = (body: string, top = "") => raw(body, top).diagnostics.map((d) => d.message);
const run = (body: string, top = "") => { const r = raw(body, top); expect(r.diagnostics.map((d) => d.message)).toEqual([]); return simulatePrograms(r.ir, 1, { strings: r.strings }); };
const shown = (sim: ReturnType<typeof run>) => sim.events.map((e) => e.text);

describe("typeof narrowing a value of the program", () => {
  const SHOW = "function show(x: number | string) { return typeof x === 'string' ? x : `#${x}`; }";
  it("in c ? a : b, a text and a number variable each take their own side", () => {
    expect(shown(run("let k = 4; print(show(k)); print(show('a')); const t = 'zz'; print(show(t));", SHOW))).toEqual(["#4", "a", "zz"]);
  });
  it("a number from the game", () => {
    const r = raw("print(show(random(9)));", SHOW);
    expect(r.diagnostics).toEqual([]);
  });
  it("giving a number, a truth value, or through an if", () => {
    const top = "function twice(x: number | string) { return typeof x === 'number' ? x * 2 : x.length; }\nfunction label(x: number | string): string { if (typeof x === 'string') return x; return `n${x}`; }\nfunction big(x: number | string) { return typeof x === 'number' ? x > 3 : x.length > 3; }";
    expect(shown(run("let k = 4; print(`${twice(k)} ${twice('abc')}`); print(label(k)); print(big(k) ? 'big' : 'small');", top))).toEqual(["8 3", "n4", "big"]);
  });
});

describe("JavaScript's clock and dice", () => {
  it("are refused inside a program, the game's own named", () => {
    expect(messages("let t = Date.now(); print(`${t % 7}`);")[0]).toMatch(/^Date\.now\(\) is the time on the computer that builds the map.*elapsed\(\).*memory\.game\.frame/);
    expect(messages("print(`${new Date().getFullYear()}`);")[0]).toMatch(/^new Date\(\) is the time/);
    expect(messages("print(`${Math.round(Math.random() * 6)}`);")[0]).toMatch(/^Math\.random\(\) would be drawn once.*random\(n\)/);
  });
  it("in a function of the script's own the program calls, once each", () => {
    expect(messages("print(`${stamp() % 7} ${roll()}`);", "function stamp() { return Date.now(); }\nfunction roll() { return Math.random() > 0.5 ? 1 : 0; }")).toEqual([
      expect.stringMatching(/^Date\.now\(\) is the time/),
      expect.stringMatching(/^Math\.random\(\) would be drawn once/),
    ]);
  });
  it("at the top of a file are the build's, and a Date of a given day is the same in every game", () => {
    expect(shown(run("print(`${BUILT > 0 ? 1 : 0} ${SEED < 100 ? 1 : 0} ${new Date(2020, 0, 1).getFullYear()}`);", "const BUILT = Date.now();\nconst SEED = Math.floor(Math.random() * 100);"))).toEqual(["1 1 2020"]);
  });
});
