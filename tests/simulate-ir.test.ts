/**
 * The program interpreter's contract with the game (`python/trigscript.py`): when a program
 * gives the frame back, and how a number comes out — the places where the obvious
 * implementation would differ from what eudplib builds.
 */
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { compileScript, type CompileResult } from "../compiler/compiler";
import { defaultScriptNames } from "../compiler/names";
import { ProgramSimulation, simulatePrograms } from "../compiler/simulateIr";
import { defaultLib } from "../bundle/lib.mjs";

const LIB = defaultLib();
const NAMES = defaultScriptNames();

const compile = (body: string): CompileResult => {
  const r = compileScript(ts, { "main.ts": `program(() => {${body}});` }, NAMES, { lib: LIB });
  expect(r.diagnostics).toEqual([]);
  return r;
};
const after = (body: string, frames = 1) => { const r = compile(body); return simulatePrograms(r.ir, frames, { strings: r.strings }); };

describe("frames", () => {
  it("a game loop with a sleep runs once every that many frames", () => {
    const sim = after(`let n = 0; while (true) { n += 1; displayText("n"); sleep(frames(2)); }`, 12);
    expect(sim.events.map((e) => e.cycle)).toEqual([0, 2, 4, 6, 8, 10]);
    expect(sim.value("n")).toBe(6);
  });
  it("loops run to completion within a frame", () => {
    const sim = after(`let i = 0; while (true) { i = 0; while (i < 5) { i += 1; } if (i == 5) { displayText("five"); } sleep(frames(1)); }`, 3);
    expect(sim.events.map((e) => `${e.cycle}:${e.text}`)).toEqual(["0:five", "1:five", "2:five"]);
  });
  it("a sleep inside a nested loop and inside a function resumes where it left off", () => {
    const sim = after(`function pause() { sleep(frames(1)); } let i = 0; while (i < 3) { displayText("in"); pause(); i += 1; } displayText("out");`, 6);
    expect(sim.events.map((e) => `${e.cycle}:${e.text}`)).toEqual(["0:in", "1:in", "2:in", "3:out"]);
    expect(sim.finished()).toBe(true);
  });
  it("stops when a runaway program never gives the frame back", () => {
    const r = compile(`let n = 0; let m = 0; while (n < 3) { m++; if (m > 4000000000) n++; }`);
    expect(() => new ProgramSimulation(r.ir, { strings: r.strings, maxStepsPerCycle: 1000 }).step()).toThrow(/sleep/);
  });
});

describe("numbers come out as the game computes them", () => {
  const value = (body: string, name = "out") => after(body).value(name);

  it("a sum stops at 0 as a whole, not term by term", () => {
    expect(value("let a = 3; let b = 10; let out = 0; out = a - b + 9;")).toBe(2);
    expect(value("let a = 3; let b = 10; let out = 0; out = a - b;")).toBe(0);
  });
  it("what is added wraps at 2³² once a variable is part of it; constants alone are exact", () => {
    expect(value("let a = 4294967295; let b = 1; let out = 0; out = a + b - 1;")).toBe(0);
    expect(value("let out = 0; out = 4294967295 + 1 - 1;")).toBe(4294967295);
  });
  it("a comparison moves what a side subtracts to the other side", () => {
    expect(value("let a = 3; let b = 5; let out = 0; if (a - b == 0) out = 1;")).toBe(0);
    expect(value("let a = 3; let b = 5; let out = 0; if (a - b < 0) out = 1;")).toBe(1);
    expect(value("let a = 3; let out = 0; if (a >= -1) out = 1;")).toBe(1);
    expect(value("let a = 3; let out = 0; if (-a < 0) out = 1;")).toBe(1);
  });
  it("Math.abs is the distance, whichever side is larger", () => {
    expect(value("let a = 20; let b = 5; let out = 0; out = Math.abs(b - a);")).toBe(15);
    expect(value("let a = 20; let b = 5; let out = 0; out = Math.abs(a - b) + Math.abs(3 - 10);")).toBe(22);
  });
  it("× wraps, ÷ and % round down, and a divisor of 0 gives 0", () => {
    expect(value("let a = 65536; let out = 0; out = a * a + 7;")).toBe(7);
    expect(value("let a = 7; let b = 2; let out = 0; out = a / b * 10 + a % b;")).toBe(31);
    expect(value("let a = 7; let z = 0; let out = 0; out = a / z + a % z + 4;")).toBe(4);
  });
  it("a negative constant is something subtracted, never its 32-bit pattern", () => {
    expect(value("let a = 10; let out = 0; out = a + -3;")).toBe(7);
    expect(value("const k = -4; let a = 10; let out = 0; out = a + k;")).toBe(6);
  });
});
