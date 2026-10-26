// The cheaper lowering (TrigScript 4): what the number pass now knows about a loop's counter, which lets the backends
// compare it without an addition a side. Read from the IR the compile gives, and run in the simulator to show the
// numbers come out the same.
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { compileScript } from "../compiler/compiler";
import { defaultScriptNames } from "../compiler/names";
import { simulatePrograms } from "../compiler/simulateIr";
import { defaultLib } from "../bundle/lib.mjs";

const LIB = defaultLib();
const compile = (body: string) => compileScript(ts, { "main.ts": `import { program, deaths, units, P8, displayText } from "trigscript";\nprogram(() => {\n  const zero = deaths(P8, units.TerranMarine);\n${body}\n});` }, defaultScriptNames(), { lib: LIB });

/** The `unsigned` of each comparison of the program's `for` loops, in order. */
function loopTests(body: string): unknown[] {
  const r = compile(body);
  expect(r.diagnostics.map((d) => d.message)).toEqual([]);
  const out: unknown[] = [];
  const walk = (o: unknown) => {
    if (!o || typeof o !== "object") return;
    const n = o as { kind?: string; cond?: { kind: string; unsigned?: unknown } };
    if (n.kind === "for" && n.cond?.kind === "compare") out.push(n.cond.unsigned ?? false);
    for (const v of Object.values(o)) walk(v);
  };
  walk(r.ir);
  return out;
}

describe("a loop's counter", () => {
  it("counted up by one from zero under i < n is never below zero: the comparison reads it from 0 up", () => {
    expect(loopTests("let n = zero + 5; let s = 0;\nfor (let i = 0; i < n; i++) s += i;")).toEqual(["left"]);
    expect(loopTests("let n = zero + 5; let s = 0;\nfor (let i = 2; n > i; i += 1) s += i;")).toEqual(["right"]);
  });

  it("is not trusted when the loop's body stores into it, a function does, it starts below zero, or the test is <=", () => {
    expect(loopTests("let n = zero + 5; let s = 0;\nfor (let i = 0; i < n; i++) { s += i; i = n + 7; }")).toEqual([false]);
    expect(loopTests("let n = zero + 5;\nfor (let i = -1; i < n; i++) displayText(`${i}`);")).toEqual([false]);
    expect(loopTests("let n = zero + 5;\nfor (let i = 0; i <= n; i++) displayText(`${i}`);")).toEqual([false]);
    expect(loopTests("let n = zero + 5;\nfor (let i = 0; i < n; i += 2) displayText(`${i}`);")).toEqual([false]);
  });

  it("gives the same numbers as before, a negative bound included", () => {
    const r = compile("let n = zero + 4; let m = zero - 3; let s = 0, t = 0;\nfor (let i = 0; i < n; i++) s += i;\nfor (let i = 0; i < m; i++) t += 1;\ndisplayText(`${s} ${t}`);");
    expect(r.diagnostics).toEqual([]);
    const sim = simulatePrograms(r.ir, 1, { strings: r.strings });
    expect(sim.events.filter((e) => e.text).map((e) => e.text)).toEqual(["6 0"]);
  });
});

describe("a store that adds to its own variable", () => {
  it("still wraps and still reads the variable before what it adds, in the simulator as in the IR", () => {
    const r = compile("let x = zero + 2147483647; x += 1; let y = zero + 5; y = y - 7; let z = zero + 1; z = 3 + z;\ndisplayText(`${x} ${y} ${z}`);");
    expect(r.diagnostics).toEqual([]);
    const sim = simulatePrograms(r.ir, 1, { strings: r.strings });
    expect(sim.events.filter((e) => e.text).map((e) => e.text)).toEqual(["-2147483648 -2 4"]);
  });
});
