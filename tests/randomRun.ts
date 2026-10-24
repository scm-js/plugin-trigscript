/**
 * A random script (`randomScript.ts`) put through the three runs a machine without the game can make — JavaScript,
 * the simulator, and the built map of our own walked as the game walks it (`ownWalk.ts`) — and the first thing that
 * disagrees, said as a line. `tests/random-scripts.test.ts` runs it over the seeds; `scripts/random-scripts.mts` adds
 * the lifted game, both builds.
 */
import ts from "typescript";
import { compileScript, type CompileResult } from "../compiler/compiler";
import { defaultScriptNames } from "../compiler/names";
import { buildOwnMap, isRefused } from "../compiler/backend/build";
import { simulatePrograms } from "../compiler/simulateIr";
import { defaultLib } from "../bundle/lib.mjs";
import { renderScript, runJs, type Generated } from "./randomScript";
import { scenario } from "./ownScenario";
import { walkBuiltMap } from "./ownWalk";

let lib: ReturnType<typeof defaultLib> | undefined;
const NAMES = defaultScriptNames();
const CHK = scenario();

export const OWN = { players: { slots: [0, 1], forces: [0, 1, 0, 0, 0, 0, 0, 0] }, humans: [0], width: 64 * 32, height: 64 * 32 };

export function compileRandom(g: Generated): CompileResult {
  lib ??= defaultLib();
  return compileScript(ts, { "main.ts": renderScript(g) }, NAMES, { lib, emitter: false, own: OWN });
}

export interface Outcome {
  /** What went wrong, or nothing. */
  problem?: string;
  /** Which run disagreed: "compile", "fault", "js", "refused", "walk". */
  kind?: string;
  lines: number;
}

/** The first `n` lines that differ, side by side. */
export function diff(want: string[], got: string[], n = 3): string {
  const out: string[] = [];
  for (let i = 0; i < Math.max(want.length, got.length) && out.length < n; i++) if (want[i] !== got[i]) out.push(`  at ${i}: expected ${JSON.stringify(want[i])}, got ${JSON.stringify(got[i])}`);
  return `${want.length} lines against ${got.length}\n${out.join("\n")}`;
}

/** The simulator's lines as `cycle:text`. */
export function simLines(r: CompileResult, frames: number) {
  const sim = simulatePrograms(r.ir, frames, { strings: r.strings });
  return { sim, lines: sim.events.filter((e) => e.text !== undefined).map((e) => `${e.cycle}:${e.text}`) };
}

export function checkRandom(g: Generated, through: { js?: boolean; walk?: boolean } = { js: true, walk: true }): Outcome {
  const r = compileRandom(g);
  if (r.diagnostics.length) return { kind: "compile", problem: r.diagnostics.map((d) => `${d.file}:${d.line}:${d.column} ${d.message}`).join("\n"), lines: 0 };
  const { sim, lines } = simLines(r, g.frames);
  if (sim.faults.length) return { kind: "fault", problem: sim.faults.map((f) => `${f.at.line}:${f.at.column} ${f.message}`).join("\n"), lines: lines.length };
  if (through.js !== false) {
    const js = runJs(g);
    if (js.join("\n") !== lines.join("\n")) return { kind: "js", problem: `the simulator against JavaScript: ${diff(js, lines)}`, lines: lines.length };
  }
  if (through.walk !== false) {
    const out = buildOwnMap({ chk: CHK, compiled: r });
    if (isRefused(out)) return { kind: "refused", problem: out.refused, lines: lines.length };
    const walked = walkBuiltMap(out.chk, out.stats.players, out.stats.entries, g.frames);
    const got = walked.printed.map((p) => `${p.frame - 1}:${p.text}`);
    if (got.join("\n") !== lines.join("\n")) return { kind: "walk", problem: `the map walked against the simulator: ${diff(lines, got)}`, lines: lines.length };
  }
  return { lines: lines.length };
}
