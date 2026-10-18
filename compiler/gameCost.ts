/**
 * What a frame costs (TrigScript 4, A4): the conditions and actions the game ran in each frame of a test, and by
 * line of the script, read from the lifted game's count (scm-sim's `src/exact/cost.ts`) through the build's map of
 * triggers. Lifted wall time is not the game's, so the count is the measure; `probes/frame-cost.ts` is the dial that
 * says what count Remastered feels.
 *
 * A record is put down to a line by the trigger it is in: the build's map says which statement made each trigger.
 * eudplib's variables, its functions and the triggers no statement made are counted under the line that ran just
 * before them in the frame, since a line's work is its own triggers and the variables they go through (measured on a
 * loop: `x += 1` is 7 actions of its own and 2 more in eudplib's variables). What eudplib runs before any line in a
 * frame (its start, once, and its work at the top of every frame) and the map's triggers outside the payload are
 * counted under no line: `TestCost.other`.
 */
import { ENTRY_FILE } from "./compiler";
import type { TriggerMap } from "./gameVariables";

/** What the host counted (scm-sim's `CostTap`, by shape: TrigScript never imports the engine). */
export interface GameCostTap {
  /**
   * A record's address → the group it is counted under: a group's number, -1 for none, or -2 (`CARRY`) for "the
   * group counted just before it in the frame, or none when it is the first".
   */
  group: ((record: number) => number) | null;
  report(from?: number): {
    from: number;
    conditions: number[];
    actions: number[];
    /** Of those, the records under no group. */
    ungrouped: number[];
    groups: Map<number, { conditions: number; actions: number; frames: number; peak: number; peakFrame: number }>;
  };
}

/** A line's cost over a test's run. */
export interface LineCost {
  file: string;
  line: number;
  /** Conditions and actions over the run. */
  total: number;
  /** The most in one frame, and the first frame it was that many. */
  peak: number;
  peakFrame: number;
  /** Frames the line ran in. */
  frames: number;
}

/** What a test's run in the game cost. */
export interface TestCost {
  /** The frame `perFrame` starts at. */
  from: number;
  /** Conditions and actions a frame that the script's build ran: its lines, eudplib's variables and functions. */
  perFrame: number[];
  /**
   * What the map's other triggers ran a frame: eudplib's start (once, by frame 2: tens of thousands on any map) and
   * any trigger the map has besides the build's. Kept apart so that the script's own peak is not that start.
   */
  other: number[];
  /** The most of `perFrame`, and the first frame it was that many. */
  peak: number;
  peakFrame: number;
  /** By line, the costliest first. */
  lines: LineCost[];
}

/** What `GameCostTap.group` answers for a record counted under the record before it (scm-sim's `CARRY`). */
const CARRY = -2;

/** How records become lines, for one build: set on the host's tap once, read after every test. */
export class CostLines {
  private readonly at: { file: string; line: number }[] = [];
  private readonly ids = new Map<string, number>();
  private readonly byRecord = new Map<number, number>();
  private readonly payloadStart: number;
  private readonly payloadEnd: number;

  /** `payloadEnd`: where eudplib's payload ends in the game's memory (the host says; the end of `STRx`). */
  constructor(map: TriggerMap, payloadEnd: number) {
    this.payloadEnd = payloadEnd;
    this.payloadStart = payloadEnd - map.payload;
    for (const [offset, conditions, actions, origin] of map.triggers) {
      const where = lineOf(origin);
      const g = where ? this.idOf(where) : CARRY;
      const at = this.payloadStart + offset;
      for (let i = 0; i < conditions; i++) this.byRecord.set(at + 8 + 20 * i, g);
      for (let i = 0; i < actions; i++) this.byRecord.set(at + 8 + 320 + 32 * i, g);
    }
  }

  private idOf(where: { file: string; line: number }): number {
    const key = `${where.file}:${where.line}`;
    let id = this.ids.get(key);
    if (id === undefined) { id = this.at.length; this.at.push(where); this.ids.set(key, id); }
    return id;
  }

  /** The lines groups stand for, by group: what the tap's groups are numbers into. */
  get places(): readonly { file: string; line: number }[] { return this.at; }

  /** For the host's tap. */
  readonly group = (record: number): number => {
    const g = this.byRecord.get(record);
    if (g !== undefined) return g;
    return record >= this.payloadStart && record < this.payloadEnd ? CARRY : -1;
  };

  /** The tap's count since the game was put back, as a test's cost. */
  read(tap: GameCostTap): TestCost {
    const r = tap.report(0);
    const perFrame = r.conditions.map((c, i) => c + r.actions[i] - r.ungrouped[i]);
    let peak = 0, peakFrame = r.from;
    perFrame.forEach((n, i) => { if (n > peak) { peak = n; peakFrame = r.from + i; } });
    const lines: LineCost[] = [];
    for (const [g, k] of r.groups) {
      const where = this.at[g];
      if (!where) continue;
      lines.push({ file: where.file, line: where.line, total: k.conditions + k.actions, peak: k.peak, peakFrame: k.peakFrame, frames: k.frames });
    }
    lines.sort((a, b) => b.peak - a.peak || b.total - a.total);
    return { from: r.from, perFrame, other: [...r.ungrouped], peak, peakFrame, lines };
  }
}

/** "main.ts:12:5" or "12:5" → the file and line; null for eudplib's ("fn:…", "eudplib", ""). */
function lineOf(origin: string): { file: string; line: number } | null {
  const m = /^(?:(.*):)?(\d+):\d+$/.exec(origin);
  return m ? { file: m[1] || ENTRY_FILE, line: Number(m[2]) } : null;
}

/** One number a frame, short: 640, 12.3k, 1.0M. */
export function shortCount(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1e6) return `${(n / 1000).toFixed(n < 1e4 ? 1 : 0)}k`;
  return `${(n / 1e6).toFixed(1)}M`;
}

/**
 * Every test's cost folded into one per line: the most a frame the line ran in any test, and the test it was in.
 * What the editor puts beside each line after a run in the game.
 */
export function costByLine(costs: { id: string; cost: TestCost }[]): (LineCost & { test: string })[] {
  const out = new Map<string, LineCost & { test: string }>();
  for (const { id, cost } of costs) for (const l of cost.lines) {
    const key = `${l.file}:${l.line}`, was = out.get(key);
    if (!was || l.peak > was.peak) out.set(key, { ...l, test: id });
  }
  return [...out.values()];
}
