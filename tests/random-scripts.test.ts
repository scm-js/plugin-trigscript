/**
 * Whole programs made at random (TrigScript 4, step 16: the gate before the Python goes), each run three ways — as
 * JavaScript, in the simulator, and as the map of our own walked from its bytes — and every line compared, frame by
 * frame. RANDOM_SCRIPTS=n runs n seeds (60 by default; about a second each, three programs a seed); RANDOM_SEED=n one seed,
 * its source printed. `scripts/random-scripts.mts` runs the same seeds in the lifted game, and cuts a failure down.
 */
import { describe, expect, it } from "vitest";
import { randomScript, renderScript } from "./randomScript";
import { checkRandom } from "./randomRun";

const N = Number(process.env.RANDOM_SCRIPTS ?? 60);
const ONE = process.env.RANDOM_SEED ? Number(process.env.RANDOM_SEED) : undefined;

describe("random scripts", () => {
  it("print the same lines in JavaScript, in the simulator and from the built map's bytes", () => {
    const bad: string[] = [];
    let lines = 0, kinds = { compile: 0, fault: 0, js: 0, refused: 0, walk: 0 } as Record<string, number>;
    const seeds = ONE !== undefined ? [ONE] : Array.from({ length: N }, (_, i) => i + 1);
    for (const seed of seeds) {
      const g = randomScript(seed);
      if (ONE !== undefined) console.log(renderScript(g));
      const o = checkRandom(g);
      lines += o.lines;
      if (o.problem) { kinds[o.kind!]++; bad.push(`seed ${seed} (${o.kind}): ${o.problem}`); }
    }
    if (process.env.RANDOM_REPORT) console.log(`${seeds.length} seeds, ${lines} lines compared`, kinds);
    expect(bad.join("\n\n")).toBe("");
    // (A seed that prints nothing would compare nothing: the programs print a line a frame.)
    expect(lines).toBeGreaterThan(seeds.length * 3);
  }, 900_000);
});
