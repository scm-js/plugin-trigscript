/**
 * Value ranges (compiler/ranges.ts): what the pass finds for the shapes a script is written in, and — over every game
 * probe — that a program with ranges does in the simulator exactly what it does without them (the comparisons the
 * ranges settle, or read unsigned, must come out the same).
 */
import ts from "typescript";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { compileScript } from "../compiler/compiler";
import { defaultScriptNames } from "../compiler/names";
import { simulatePrograms } from "../compiler/simulateIr";
import { defaultLib } from "../bundle/lib.mjs";

const lib = defaultLib();
const compile = (files: Record<string, string>, ranges = true) => compileScript(ts, files, defaultScriptNames(), { lib, ranges });
const body = (code: string) => ({ "main.ts": `import { program, sleep, frames, deaths, units, P8, start } from "trigscript";\nprogram(() => {\n${code}\n});` });

/** The range written into the first number of the IR whose label starts with `label` (a binary or an intrinsic). */
function rangeAt(ir: unknown, label: string): [number, number] | undefined | null {
  let found: [number, number] | undefined | null = null;
  const walk = (x: unknown) => {
    if (found !== null || !x || typeof x !== "object") return;
    if (Array.isArray(x)) { x.forEach(walk); return; }
    const o = x as Record<string, unknown>;
    if (typeof o.label === "string" && o.label.startsWith(label) && (o.kind === "binary" || o.kind === "intrinsic")) { found = o.range as [number, number] | undefined; return; }
    for (const v of Object.values(o)) walk(v);
  };
  walk(ir);
  return found;
}

describe("value ranges", () => {
  it("knows a mask, a remainder, a clamp and a quotient", () => {
    const r = compile(body(`
      const zero = deaths(P8, units.TerranMarine);
      const s = (zero + 200) & 1023;
      let q = s / 3;
      let c = Math.min(s, 100);
      let m = s % 10;
      sleep(frames(1));`));
    expect(r.diagnostics).toEqual([]);
    expect(rangeAt(r.ir, "L5: (zero + 200) & 1023")).toEqual([0, 1023]);
    expect(rangeAt(r.ir, "L6: s / 3")).toEqual([0, 341]);
    expect(rangeAt(r.ir, "L7: Math.min(s, 100)")).toEqual([0, 100]);
    expect(rangeAt(r.ir, "L8: s % 10")).toEqual([0, 9]);
  });

  it("settles on a counter wrapped by a mask, which creeps one a pass until widened and narrowed back", () => {
    const r = compile(body(`
      let k = 0;
      while (true) { k = (k + 1) & 15; const j = k * 3; sleep(frames(1)); }`));
    expect(rangeAt(r.ir, "L5: k * 3")).toEqual([0, 45]);
  });

  it("keeps a loop's test at its update, and nothing of it after a wait", () => {
    const r = compile(body(`
      const zero = deaths(P8, units.TerranMarine);
      let n = (zero & 7) + 4;
      let t = 0;
      for (let i = 0; i < n; i++) { t = i * 5; }
      for (let i2 = 0; i2 < n; i2++) { sleep(frames(1)); t = i2 * 7; }
      sleep(frames(1));`));
    expect(rangeAt(r.ir, "L7: i * 5")).toEqual([0, 50]);
    // The second loop waits in its body, but nothing else stores into its counter: what the test said holds after.
    expect(rangeAt(r.ir, "L8: i2 * 7")).toEqual([0, 70]);
  });

  it("takes nothing from a store it cannot see: a task's handle", () => {
    const r = compile({ "main.ts": `import { program, sleep, frames, start } from "trigscript";
      async function wave(n: number) { await sleep(frames(n)); }
      program(async () => { const w = start(wave(3)); await w; });` });
    expect(r.diagnostics).toEqual([]);
    // \`w\` is declared from the handle start() wrote, which was 0 before it: no range may say 0 … 0.
    let init: { range?: unknown } | undefined;
    const walk = (x: unknown) => { if (!x || typeof x !== "object") return; if (Array.isArray(x)) { x.forEach(walk); return; } const o = x as Record<string, unknown>; if (o.kind === "declare" && (o.decl as { name?: string })?.name === "w") init = o.init as { range?: unknown }; for (const v of Object.values(o)) walk(v); };
    walk(r.ir);
    expect(init).toBeDefined();
    expect(init!.range).toBeUndefined();
  });

  it("forgets what an if said once the variable is stored into", () => {
    const r = compile(body(`
      const zero = deaths(P8, units.TerranMarine);
      let x = zero;
      if (x < 10) { x = x * 1000; const y = x * 2; }
      sleep(frames(1));`));
    expect(rangeAt(r.ir, "L6: x * 1000")).toBeUndefined(); // below zero too: x is any number below 10
    expect(rangeAt(r.ir, "L6: x * 2")).toBeUndefined();
  });
});

describe("value ranges change nothing a program does", () => {
  const dir = join(import.meta.dirname, "..", "probes");
  const probes = readdirSync(dir).filter((f) => /^game-.*\.tsx?$/.test(f));
  for (const f of probes) {
    it.concurrent(f, () => {
      const src = readFileSync(join(dir, f), "utf8");
      const files = { [f.endsWith(".tsx") ? "main.tsx" : "main.ts"]: src };
      const frames = 160;
      const run = (ranges: boolean) => {
        const r = compile(files, ranges);
        expect(r.diagnostics).toEqual([]);
        const sim = simulatePrograms(r.ir, frames, { strings: r.strings });
        return { shown: sim.events.filter((e) => e.text).map((e) => `${e.cycle}:${e.text}`), faults: sim.faults };
      };
      expect(run(true)).toEqual(run(false));
    }, 120_000);
  }
});
