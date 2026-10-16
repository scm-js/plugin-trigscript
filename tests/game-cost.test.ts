// What a frame costs (TrigScript 4, A4), without a game: the build's map of triggers turns records into lines, and a
// tap shaped like scm-sim's CostTap is read back as a test's cost.
import { describe, expect, it } from "vitest";
import { CostLines, costByLine, shortCount, type GameCostTap } from "../compiler/gameCost";
import type { TriggerMap } from "../compiler/gameVariables";

const END = 0x19200000;
// A payload of 4000 bytes: a trigger of line 12 at 0 (one condition, two actions), one of eudplib's at 2400 (no
// line), and one of main.ts line 30 at 1200.
const MAP: TriggerMap = { payload: 4000, triggers: [[0, 1, 2, "main.ts:12:5"], [2400, 0, 1, "eudplib"], [1200, 0, 1, "30:3"]] };
const START = END - 4000;
const cond = (trigger: number, i: number) => START + trigger + 8 + 20 * i;
const act = (trigger: number, i: number) => START + trigger + 8 + 320 + 32 * i;

/** The tap's rules (scm-sim's CostTap, in small): a frame's records in order, a carried one under the one before it. */
function tap(frames: number[][]): GameCostTap {
  const t: GameCostTap = {
    group: null,
    report() {
      const groups = new Map<number, { conditions: number; actions: number; frames: number; peak: number; peakFrame: number }>();
      const conditions: number[] = [], actions: number[] = [], ungrouped: number[] = [];
      frames.forEach((records, f) => {
        let last = -1, c = 0, a = 0, u = 0;
        const now = new Map<number, number>();
        for (const r of records) {
          const isCondition = (r - START - 8) % 20 === 0 && (r - START) % 1200 < 328;
          if (isCondition) c++; else a++;
          let g = t.group!(r);
          if (g === -2) g = last; else last = g;
          if (g < 0) { u++; continue; }
          now.set(g, (now.get(g) ?? 0) + 1);
          const k = groups.get(g) ?? { conditions: 0, actions: 0, frames: 0, peak: 0, peakFrame: f };
          if (isCondition) k.conditions++; else k.actions++;
          groups.set(g, k);
        }
        for (const [g, n] of now) { const k = groups.get(g)!; k.frames++; if (n > k.peak) { k.peak = n; k.peakFrame = f; } }
        conditions.push(c); actions.push(a); ungrouped.push(u);
      });
      return { from: 0, conditions, actions, ungrouped, groups };
    },
  };
  return t;
}

describe("CostLines", () => {
  it("puts a record down to its trigger's line, eudplib's under the line before it, and keeps the rest apart", () => {
    const lines = new CostLines(MAP, END);
    expect(lines.group(cond(0, 0))).toBeGreaterThanOrEqual(0);
    expect(lines.group(act(0, 1))).toBe(lines.group(cond(0, 0)));
    expect(lines.group(act(2400, 0))).toBe(-2);
    expect(lines.group(START + 3000)).toBe(-2);
    expect(lines.group(0x51a284)).toBe(-1);
    expect(lines.group(END)).toBe(-1);
  });

  it("reads a test's cost: by frame without what eudplib ran before any line, by line with the variables a line went through", () => {
    const lines = new CostLines(MAP, END);
    const t = tap([
      [0x51a284, act(2400, 0), act(2400, 0)],                                      // eudplib's start: none of it a line's
      [act(2400, 0), cond(0, 0), act(0, 0), act(0, 1), act(2400, 0), act(1200, 0)], // eudplib, line 12 + a variable, line 30
      [act(1200, 0), act(2400, 0), act(2400, 0)],                                    // line 30 + two variables
    ]);
    t.group = lines.group;
    const cost = lines.read(t);
    expect(cost.perFrame).toEqual([0, 5, 3]);
    expect(cost.other).toEqual([3, 1, 0]);
    expect(cost.peak).toBe(5);
    expect(cost.peakFrame).toBe(1);
    expect(cost.lines).toEqual([
      { file: "main.ts", line: 12, total: 4, peak: 4, peakFrame: 1, frames: 1 },
      { file: "main.ts", line: 30, total: 4, peak: 3, peakFrame: 2, frames: 2 },
    ]);
  });
});

describe("costByLine", () => {
  it("keeps each line's most in a frame over every test, and the test it was in", () => {
    const line = (l: number, peak: number) => ({ file: "main.ts", line: l, total: peak, peak, peakFrame: 1, frames: 1 });
    const cost = (lines: ReturnType<typeof line>[]) => ({ from: 0, perFrame: [], other: [], peak: 0, peakFrame: 0, lines });
    const out = costByLine([{ id: "a", cost: cost([line(3, 10), line(4, 900)]) }, { id: "b", cost: cost([line(3, 2000)]) }]);
    expect(out.find((l) => l.line === 3)).toMatchObject({ peak: 2000, test: "b" });
    expect(out.find((l) => l.line === 4)).toMatchObject({ peak: 900, test: "a" });
  });
});

describe("shortCount", () => {
  it("writes a count short", () => {
    expect([640, 1234, 30708, 1004714].map(shortCount)).toEqual(["640", "1.2k", "31k", "1.0M"]);
  });
});
