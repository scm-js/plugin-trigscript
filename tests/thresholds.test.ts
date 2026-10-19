/**
 * A division whose result is small, as comparisons with thresholds (compiler/thresholds.ts): the tree gives the very
 * bits the division gives, for every divisor — edges of each threshold, where the quotient wraps, at and below zero.
 */
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { divisionByThresholds } from "../compiler/thresholds";
import { fixedDiv } from "../compiler/fixedMath";
import type { BoolExpr, NumExpr } from "../compiler/ir";
import { compileScript, type CompileResult } from "../compiler/compiler";
import { defaultScriptNames } from "../compiler/names";
import { simulatePrograms } from "../compiler/simulateIr";
import { defaultLib } from "../bundle/lib.mjs";

const LIB = defaultLib();
const compile = (source: string): CompileResult => {
  const r = compileScript(ts, { "main.ts": source }, defaultScriptNames(), { lib: LIB });
  expect(r.diagnostics.map((d) => `${d.file}:${d.line}: ${d.message}`)).toEqual([]);
  return r;
};

const at = { file: "main.ts", line: 1, column: 1 };
const k = (value: number, fixed = false): NumExpr => ({ kind: "const", value, ...(fixed ? { fixed: true } : {}) });
const x: NumExpr = { kind: "var", id: "x" };
const min = (cap: number, q: NumExpr): Extract<NumExpr, { kind: "intrinsic" }> => ({ kind: "intrinsic", name: "min", args: [k(cap), q], at, label: "" });
const floorFixed = (c: number, add = 0): NumExpr => {
  const q: NumExpr = { kind: "intrinsic", name: "fdiv", args: [k(c, true), x], at, label: "" };
  return { kind: "binary", op: ">>", left: add ? { kind: "binary", op: "+", left: q, right: k(add), at, label: "" } : q, right: k(16), at, label: "" };
};

/** The few kinds of node a tree holds, worked out for one x as the game would. */
function evaluate(e: NumExpr, xv: number): number {
  switch (e.kind) {
    case "const": return e.value;
    case "var": return xv;
    case "ternary": return truth(e.cond, xv) ? evaluate(e.whenTrue, xv) : evaluate(e.whenFalse, xv);
    case "intrinsic":
      if (e.name === "min") return Math.min(evaluate(e.args[0], xv), evaluate(e.args[1], xv));
      if (e.name === "fdiv") return fixedDiv(evaluate(e.args[0], xv), evaluate(e.args[1], xv));
      break;
    case "binary": {
      const l = evaluate(e.left, xv), r = evaluate(e.right, xv);
      if (e.op === ">>") return l >> r;
      if (e.op === "+") return (l + r) | 0;
      if (e.op === "/") return r === 0 ? 0 : Math.trunc(l / r);
      break;
    }
  }
  throw new Error(`no ${e.kind}`);
}
function truth(b: BoolExpr, xv: number): boolean {
  if (b.kind !== "compare") throw new Error(`no ${b.kind}`);
  const l = evaluate(b.left, xv), r = evaluate(b.right, xv);
  return b.op === "<" ? l < r : b.op === "<=" ? l <= r : (() => { throw new Error(b.op); })();
}

/** Divisors to try: around each threshold the tree compares with, around zero and the wrap, the ends, and many at random. */
function divisors(tree: NumExpr): number[] {
  const out = new Set<number>([-(2 ** 31), -65536, -1, 0, 1, 2, 155, 156, 157, 65535, 65536, 65537, 2 ** 31 - 1]);
  const walk = (e: NumExpr) => {
    if (e.kind === "ternary") {
      if (e.cond.kind === "compare" && e.cond.right.kind === "const") for (const d of [-1, 0, 1]) out.add(e.cond.right.value + d);
      walk(e.whenTrue); walk(e.whenFalse);
    }
  };
  walk(tree);
  let seed = 12345;
  for (let i = 0; i < 20000; i++) { seed = (seed * 1103515245 + 12345) >>> 0; out.add((seed >>> (seed & 15)) | 0); }
  return [...out].filter((v) => v >= -(2 ** 31) && v < 2 ** 31);
}

describe("a division whose result is small, as comparisons", () => {
  const cases: [string, Extract<NumExpr, { kind: "intrinsic" }>][] = [
    ["Math.min(78, Math.floor(78 / d)), d fixed", min(78, floorFixed(78 * 65536))],
    ["Math.min(96, Math.floor(1.5 / d))", min(96, floorFixed(98304))],
    ["Math.min(200, Math.round(30000 / d))", min(200, floorFixed(30000 * 65536, 32768))],
    ["Math.min(5, Math.ceil(7.25 / d))", min(5, floorFixed(475136, 65535))],
    ["Math.min(40, 1000 / n), n whole", min(40, { kind: "binary", op: "/", left: k(1000), right: x, at, label: "" })],
    ["Math.min(256, 1 / n)", min(256, { kind: "binary", op: "/", left: k(1), right: x, at, label: "" })],
  ];
  for (const [name, e] of cases) {
    it(name, () => {
      const tree = divisionByThresholds(structuredClone(e));
      expect(tree).not.toBeNull();
      for (const d of divisors(tree!)) expect([d, evaluate(tree!, d)]).toEqual([d, evaluate(e, d)]);
    });
  }
  it("is as deep as the cap has bits, behind one comparison", () => {
    let depth = 0;
    const deepest = (e: NumExpr, n: number): void => { if (e.kind === "ternary") { deepest(e.whenTrue, n + 1); deepest(e.whenFalse, n + 1); } else depth = Math.max(depth, n); };
    const tree = divisionByThresholds(structuredClone(cases[0][1]))!;
    deepest((tree as Extract<NumExpr, { kind: "ternary" }>).whenFalse, 0);
    expect(depth).toBeLessThanOrEqual(7);
  });
  it("leaves alone what it does not know falls: a cap too large, a negative or fixed cap, a constant below zero, an expression for a divisor", () => {
    expect(divisionByThresholds(min(300, floorFixed(65536)))).toBeNull();
    expect(divisionByThresholds(min(0, floorFixed(65536)))).toBeNull();
    expect(divisionByThresholds(min(10, floorFixed(-65536)))).toBeNull();
    const sum: NumExpr = { kind: "binary", op: "+", left: x, right: k(1), at, label: "" };
    expect(divisionByThresholds(min(10, { kind: "binary", op: "/", left: k(100), right: sum, at, label: "" }))).toBeNull();
    expect(divisionByThresholds({ ...min(10, floorFixed(65536)), name: "max" })).toBeNull();
  });
  it("a program prints what the division would", () => {
    const r = compile(`program(() => {
      const H = 78;
      let out = "";
      const ds: fixed[] = [fixed(0), fixed(-3), 0.001, 0.0024, 0.0025, 0.5, 1, 1.0001, 2.5, 7.99, 39, 77.9, 78, 79, 1000, 30000];
      for (const d0 of ds) {
        const d: fixed = d0 + fixed(random(1));
        out += \`\${Math.min(H, Math.floor(H / d))} \`;
      }
      print(out);
    });`);
    const want = [0, -3, 0.001, 0.0024, 0.0025, 0.5, 1, 1.0001, 2.5, 7.99, 39, 77.9, 78, 79, 1000, 30000]
      .map((d) => Math.min(78, fixedDiv(78 * 65536, Math.round(d * 65536)) >> 16)).join(" ") + " ";
    expect(simulatePrograms(r.ir, 2, { strings: r.strings }).events.map((e) => e.text)).toContain(want);
    // (The division is still there, behind the comparison for a divisor near zero; the tree is beside it.)
    expect(JSON.stringify(r.ir)).toContain('"op":"<="');
  });
});
