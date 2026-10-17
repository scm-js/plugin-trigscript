/**
 * Numbers with a fraction (TrigScript 4, B6): `fixed`, 16.16. What makes a number fixed, how it mixes with whole ones,
 * where only a whole one goes, and Math — the simulator's arithmetic (compiler/fixedMath.ts), which the lifted game
 * agrees with to the bit (probes/game-fixed.ts). And the build-time folding the fog library leans on.
 */
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { compileScript, type CompileResult } from "../compiler/compiler";
import { defaultScriptNames } from "../compiler/names";
import { simulatePrograms } from "../compiler/simulateIr";
import { fixedAtan2, fixedDiv, fixedMul, fixedSin, fixedSqrt, fixedText } from "../compiler/fixedMath";
import { atanTable, fixedRaw, SIN_SCALE, sinTable } from "../compiler/numbers";
import { defaultLib } from "../bundle/lib.mjs";

const LIB = defaultLib();
const NAMES = defaultScriptNames();
const compile = (main: string): CompileResult => compileScript(ts, { "main.ts": main }, NAMES, { lib: LIB });
const messages = (body: string) => compile(`program(() => {${body}});`).diagnostics.map((d) => d.message);
/** What a program printed: every value from a variable (gas, set to 3), so nothing is worked out when the script is built. */
const printed = (body: string): string[] => {
  const r = compile(`program(() => { setResources(P1, "set", 3, "gas"); sleep(frames(1)); const g = gas(P1); ${body} });`);
  expect(r.diagnostics.map((d) => d.message)).toEqual([]);
  return simulatePrograms(r.ir, 3, { strings: r.strings }).events.filter((e) => e.text).map((e) => e.text!);
};

describe("a number with a fraction", () => {
  it("is fixed when a fraction is stored into it, and prints as a decimal", () => {
    expect(printed("let x = g - 2; x += 0.25; displayText(`${x} ${x * 2} ${x * x} ${-x}`);")).toEqual(["1.25 2.5 1.5625 -1.25"]);
  });

  it("whole numbers divide as whole numbers, unless one side is fixed", () => {
    expect(printed("displayText(`${(g + 4) / 2} ${(g + 4) / fixed(2)} ${fixed(g) / 4}`);")).toEqual(["3 3.5 0.75"]);
  });

  it("rounds with Math.floor, ceil, round and trunc, and x | 0", () => {
    expect(printed("const m = -2.5 + (g - 3); displayText(`${Math.floor(m)} ${Math.ceil(m)} ${Math.round(m)} ${Math.trunc(m)} ${m | 0} ${Math.round(m + 5)}`);")).toEqual(["-3 -2 -2 -2 -2 3"]);
  });

  it("compares with whole numbers, and keeps its sign", () => {
    expect(printed("const h = fixed(g) / 6; displayText(`${h < 1 ? 1 : 0} ${h > 0 ? 1 : 0} ${h == 0.5 ? 1 : 0} ${Math.max(h, g)} ${Math.abs(-h)}`);")).toEqual(["1 1 1 3 0.5"]);
  });

  it("goes through arrays and functions", () => {
    expect(printed("const xs: number[] = [0, 0]; xs[1] = fixed(g) / 4; function twice(v: number): number { return v * 2; } displayText(`${xs[1]} ${twice(xs[1])}`);")).toEqual(["0.75 1.5"]);
  });

  it("is an error where only a whole number goes, with the way to round it", () => {
    expect(messages("let x = 0.5; const xs = [1, 2, 3]; let y = xs[x];").join()).toMatch(/An index is a fixed number.*Math\.floor/);
    expect(messages("let x = 0.5; let y = x << 2;").join()).toMatch(/What this shifts is a fixed number/);
    expect(messages("let x = 0.5; createUnit(P1, units.TerranMarine, x, locations.Anywhere);").join()).toMatch(/fixed number.*Math\.floor/);
    expect(messages("let n: u32 = u32(1); n = 0.5;").join()).toMatch(/n is a u32, which holds whole numbers/);
  });

  it("says where a variable became fixed", () => {
    expect(messages("let i = 0; i = 1.5; const xs = [1, 2, 3]; let y = xs[i];").join()).toMatch(/i is fixed: line 1 stores a fraction into it/);
  });

  it("holds −32 768 … 32 767.99998", () => {
    expect(messages("let x = 40000.5;").join()).toMatch(/fixed number holds −32 768/);
  });
});

describe("Math of fixed numbers, as the game computes it", () => {
  const close = (raw: number, want: number, within: number) => expect(Math.abs(raw / 65536 - want)).toBeLessThanOrEqual(within);
  const SIN = sinTable(), ATAN = atanTable();

  it("multiplies and divides towards zero", () => {
    expect(fixedMul(fixedRaw(1.5), fixedRaw(-2.25))).toBe(fixedRaw(-3.375));
    expect(fixedDiv(fixedRaw(7), fixedRaw(2))).toBe(fixedRaw(3.5));
    expect(fixedDiv(fixedRaw(1), 0)).toBe(0);
    expect(fixedMul(-1, 1)).toBe(0); // −1/65536 × 1/65536 rounds to 0, not −1/65536
  });

  it("sin, cos and atan2 are within a step of the fixed numbers everywhere", () => {
    for (let a = -10; a <= 10; a += 0.0173) {
      close(fixedSin(fixedRaw(a), SIN_SCALE, SIN), Math.sin(a), 3 / 65536 + 1e-4);
      close(fixedSin(fixedRaw(a), SIN_SCALE, SIN, true), Math.cos(a), 3 / 65536 + 1e-4);
    }
    for (let y = -3; y <= 3; y += 0.37) for (let x = -3; x <= 3; x += 0.41) close(fixedAtan2(fixedRaw(y), fixedRaw(x), ATAN), Math.atan2(fixedRaw(y) / 65536, fixedRaw(x) / 65536), 1e-4);
  });

  it("sqrt rounds down, of a fixed number and of a whole one", () => {
    expect(fixedSqrt(fixedRaw(2))).toBe(Math.floor(Math.sqrt(2 * 65536) * 256));
    expect(fixedSqrt(25, true)).toBe(fixedRaw(5));
    expect(fixedSqrt(-65536)).toBe(0);
  });

  it("prints up to four places, rounded, without trailing zeros", () => {
    expect([fixedRaw(0.1), fixedRaw(3.14159), fixedRaw(-0.5), 0, fixedRaw(2.99999)].map(fixedText)).toEqual(["0.1", "3.1416", "-0.5", "0", "3"]);
  });

  it("works in a program: sqrt, sin, cos, tan, atan2, hypot", () => {
    expect(printed("const a = Math.PI / 6 + (g - 3); const one = fixed(g) - 2; displayText(`${Math.sin(a)} ${Math.cos(one)} ${Math.tan(one)} ${Math.atan2(one, -one)} ${Math.sqrt(fixed(g) - 1)} ${Math.hypot(g, g + 1)}`);"))
      .toEqual(["0.5 0.5403 1.5573 2.3562 1.4142 5"]);
  });
});

describe("what a library's function knows when the script is built", () => {
  const ok = (main: string) => { const r = compile(main); expect(r.diagnostics.map((d) => d.message)).toEqual([]); return r; };

  it("a switch over a value known then keeps only its case, as far as it falls through", () => {
    const r = ok(`const f = game((n: number) => { switch (n) { case 1: displayText("one"); case 2: displayText("two"); break; case 3: displayText("three"); } });\nprogram(() => { f(1); });`);
    const sim = simulatePrograms(r.ir, 1, { strings: r.strings });
    expect(sim.events.map((e) => e.text)).toEqual(["one", "two"]);
  });

  it("?? || && and comparisons fold over values known then; a const set from them is one", () => {
    const r = ok(`interface O { readonly width?: number; readonly ink?: string }\nconst f = game((o: O, xs: readonly number[]) => { const w = o.width ?? 3; const dark = o.ink === "dark"; const n: number[] = new Array(w).fill(0); if (dark || w > 4) displayText("wide or dark"); setResources(P1, "set", n.length + xs[0], "ore"); });\nprogram(() => { const xs: number[] = [1]; f({ ink: "dark" }, xs); f({ width: 2 }, xs); });`);
    expect(simulatePrograms(r.ir, 1, { strings: r.strings }).events.filter((e) => e.text).map((e) => e.text)).toEqual(["wide or dark"]);
  });

  it("an optional parameter left out is undefined, and an array given is there", () => {
    const r = ok(`const f = game((xs?: readonly number[]) => { if (xs !== undefined) displayText("given"); else displayText("left out"); });\nprogram(() => { const a: number[] = [1]; f(a); f(); });`);
    expect(simulatePrograms(r.ir, 1, { strings: r.strings }).events.map((e) => e.text)).toEqual(["given", "left out"]);
  });
});
