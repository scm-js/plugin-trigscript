/**
 * The program interpreter (`simulateIr.ts`) against the trigger interpreter over the
 * classic backend's own output — the same programs, the same cycles, the same events —
 * and the two targets against each other: the same events in the same order, whatever
 * the timing.
 */
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { ActionType, type ActionRecord } from "../vendor/triggers";
import { compileScript, type CompileResult } from "../compiler/compiler";
import { checkForTarget } from "../compiler/eud";
import { defaultScriptNames } from "../compiler/names";
import { Simulation } from "../compiler/simulate";
import { ProgramSimulation } from "../compiler/simulateIr";
import { defaultLib } from "../bundle/lib.mjs";

const LIB = defaultLib();
const NAMES = defaultScriptNames();

const compile = (src: string): CompileResult => {
  const r = compileScript(ts, { "main.ts": src }, NAMES, { lib: LIB });
  expect(r.diagnostics).toEqual([]);
  return r;
};
const program = (body: string, options = "") => `program(() => {${body}}${options ? `, ${options}` : ""});`;

const key = (cycle: number, a: ActionRecord, text: string | undefined) => `${cycle}:${a.type}:${text ?? ""}:${a.player}:${a.unitId}:${a.modifier}:${a.target}`;
const shape = (a: ActionRecord, text: string | undefined) => `${a.type}:${text ?? ""}:${a.player}:${a.unitId}:${a.modifier}:${a.target}`;

/** Cycle for cycle: the trigger interpreter over the triggers, the program interpreter over the IR, both classic. */
function classicParity(src: string, cycles: number, seed = 0.3) {
  const r = compile(src);
  const player = r.programs[0]?.owner ?? 0;
  const triggers = new Simulation(r.triggers, { strings: r.strings, player, random: () => seed }).run(cycles);
  const ir = new ProgramSimulation(r.ir, { target: "classic", strings: r.strings, player, random: () => seed }).run(cycles);
  expect(ir.events.map((e) => key(e.cycle, e.action, e.text))).toEqual(triggers.events.map((e) => key(e.cycle, e.action, e.text)));
  return { r, triggers, ir };
}

/** The same events in the same order on both targets, up to the shorter run. */
function targetParity(src: string, cycles: number, seed = 0.3) {
  const r = compile(src);
  for (const p of r.ir) expect(checkForTarget(p, "remastered")).toEqual([]);
  const player = r.programs[0]?.owner ?? 0;
  const classic = new ProgramSimulation(r.ir, { target: "classic", strings: r.strings, player, random: () => seed }).run(cycles);
  const remastered = new ProgramSimulation(r.ir, { target: "remastered", strings: r.strings, player, random: () => seed }).run(cycles);
  const a = classic.events.map((e) => shape(e.action, e.text));
  const b = remastered.events.map((e) => shape(e.action, e.text));
  const n = Math.min(a.length, b.length);
  expect(n).toBeGreaterThan(0);
  expect(b.slice(0, n)).toEqual(a.slice(0, n));
  return { classic, remastered };
}

const PROGRAMS: Record<string, string> = {
  "a counter that wins": program(`let n = 0; while (true) { n += 1; if (n == 3) { victory(); } }`),
  "if / else if / else": program(`let n = 0; let out = 0; while (true) { if (n == 0) { out = 10; } else if (n == 1) { out = 20; if (out >= 20) { out += 1; } } else { out = 30; } displayText("tick"); if (out == 21) { displayText("twenty-one"); } n++; }`),
  "an unrolled for with break and continue": program(`let sum = 0; for (let i = 0; i < 10; i++) { if (i == 2) continue; if (i == 5) break; sum += i; } displayText("done"); if (sum == 8) { displayText("eight"); }`),
  "sleep between statements": program(`displayText("a"); sleep(cycles(3)); displayText("b");`),
  "a loop with a sleep": program(`while (true) { displayText("w"); sleep(cycles(2)); }`),
  "seconds without hyper triggers": program(`sleep(seconds(2)); displayText("x");`),
  "do while": program(`let i = 0; do { i += 1; displayText("i"); } while (i < 3); displayText("out");`),
  "a for over a variable": program(`let n = 0; let bound = 4; for (let i = 0; i < bound; i++) { n += i; } if (n == 6) { displayText("six"); } displayText("n");`),
  "switch with fallthrough and default": program(`let x = 0; while (true) { switch (x) { case 0: displayText("zero"); break; case 1: displayText("one"); case 2: displayText("one or two"); break; default: displayText("other"); } x += 1; if (x == 4) { victory(); } }`),
  "a function with a return": program(`function twice(a: number): number { if (a > 5) { return a; } return a * 2; } let v = twice(3); if (v == 6) { displayText("six"); } v = twice(7); if (v == 7) { displayText("seven"); } victory();`),
  "once and rose": program(`let n = 0; while (true) { n += 1; if (once(n >= 2)) { displayText("once"); } if (rose(n % 2 == 0)) { displayText("rose"); } if (n == 6) { victory(); } }`),
  "booleans": program(`let a = false; let b = true; let n = 0; while (true) { a = !a; if (a && b) { displayText("both"); } if (a || n > 2) { n += 1; } if (n == 4) { victory(); } }`),
  "a sleep inside a nested loop": program(`let i = 0; while (true) { i = 0; while (i < 2) { displayText("in"); sleep(cycles(1)); i += 1; } displayText("round"); if (once(true)) { } sleep(cycles(1)); }`),
  "u8 saturation and the exact sum": program(`let a: u8 = 250; let b = 3; a = a + b + 10 - 5; if (a == 255) { displayText("saturated"); } let c = 4; c = c - 10 + 3; if (c == 0) { displayText("zero"); } victory();`),
  "a per-player program with a shared cell": program(`let mine = 0; let total = shared(0); while (true) { mine += 1; total += 2; if (mine == 3) { displayText("three"); victory(); } }`, "{ owner: AllPlayers }"),
  "continue in a while": program(`let i = 0; while (i < 5) { i += 1; if (i % 2 == 0) { continue; } displayText("odd"); } victory();`),
  "a ternary and min/max": program(`let n = 0; while (true) { n += 1; let m = n > 2 ? 100 : 1; if (m == 100) { displayText("big"); } else { displayText("small"); } if (Math.max(n, 3) == 4) { victory(); } }`),
};

describe("the program interpreter matches the trigger interpreter, cycle for cycle, on the classic target", () => {
  for (const [name, src] of Object.entries(PROGRAMS)) {
    it(name, () => { classicParity(src, 30); });
  }
  it("reads a variable by name", () => {
    const { ir } = classicParity(program(`let n = 0; while (true) { n += 1; if (n == 3) { victory(); } }`), 6);
    expect(ir.value("n")).toBe(6);
  });
  it("logs a variable-amount action once, with the amount the decomposed triggers add up to", () => {
    const r = compile(program(`let gold = 0; while (true) { gold += 7; setResources(P1, "add", gold, "ore"); if (gold == 21) { victory(); } }`));
    const triggers = new Simulation(r.triggers, { strings: r.strings, player: 0 }).run(3);
    const ir = new ProgramSimulation(r.ir, { target: "classic", strings: r.strings, player: 0 }).run(3);
    const sum = (events: { action: ActionRecord; cycle: number }[], cycle: number) => events.filter((e) => e.action.type === ActionType.SetResources && e.cycle === cycle).reduce((n, e) => n + e.action.target, 0);
    for (const c of [0, 1, 2]) expect(sum(ir.events, c)).toBe(sum(triggers.events, c));
    expect(ir.events.filter((e) => e.action.type === ActionType.SetResources).length).toBe(3);
  });
  it("stops when a runaway program never gives the cycle back", () => {
    const r = compile(program(`let n = 0; while (true) { n += 1; }`));
    const ir = new ProgramSimulation(r.ir, { target: "remastered", strings: r.strings, maxStepsPerCycle: 1000 });
    expect(() => ir.step()).toThrow(/sleep/);
  });
});

describe("the two targets do the same things", () => {
  for (const [name, src] of Object.entries(PROGRAMS)) {
    if (/never sleeps|counter that wins|if \/ else|switch|once and rose|booleans|per-player|ternary|continue in a while/.test(name)) continue; // No sleep: the Remastered target refuses these as written.
    it(name, () => { targetParity(src, 60); });
  }
  it("a game loop with a sleep runs faster on Remastered, in the same order", () => {
    const { classic, remastered } = targetParity(program(`let n = 0; while (true) { n += 1; displayText("n"); sleep(cycles(2)); }`), 12);
    expect(classic.events.map((e) => e.cycle)).toEqual([0, 3, 6, 9]);
    expect(remastered.events.map((e) => e.cycle)).toEqual([0, 2, 4, 6, 8, 10]);
  });
  it("seconds are frames on Remastered", () => {
    const r = compile(program(`sleep(seconds(1)); displayText("x");`));
    const remastered = new ProgramSimulation(r.ir, { target: "remastered", strings: r.strings }).run(30);
    expect(remastered.events.map((e) => e.cycle)).toEqual([24]);
  });
  it("loops run to completion within a frame on Remastered", () => {
    const r = compile(program(`let i = 0; while (true) { i = 0; while (i < 5) { i += 1; } if (i == 5) { displayText("five"); } sleep(cycles(1)); }`));
    const remastered = new ProgramSimulation(r.ir, { target: "remastered", strings: r.strings }).run(3);
    expect(remastered.events.map((e) => `${e.cycle}:${e.text}`)).toEqual(["0:five", "1:five", "2:five"]);
  });
});
