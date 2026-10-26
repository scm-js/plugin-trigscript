/**
 * What a frame costs (TrigScript 4, A4): the conditions and actions the game ran in each frame of a test, and by
 * line of the script, read from the lifted game's count (scm-sim's `src/exact/cost.ts`) through the build's map of
 * triggers. Lifted wall time is not the game's, so the count is the measure; `probes/frame-cost.ts` is the dial that
 * says what count Remastered feels.
 *
 * A record is put down to a line by the trigger it is in: the build's map says which statement made each trigger.
 * The build's own triggers — a variable's cell, the routes into its places, a run's wake, the gates — and the triggers
 * no statement made are counted under the line that ran just before them in the frame, since a line's work is its own
 * triggers and the variables they go through. What runs before any line in a frame (the start-up, once, and the
 * build's work at the top of every frame) and the map's triggers outside the payload are counted under no line:
 * `TestCost.other`.
 *
 * Where the host's tap can weigh (scm-sim's frame-weights change: it counts triggers too and asks a weigher what each
 * costs), every count also comes as time: `RemasteredWeigh` says what Remastered spends on each trigger and record
 * (`compiler/remasteredCost.ts`), and `TestCost.ms` / `LineCost.ms` hold the milliseconds. Without it, counts alone.
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
  /** What each trigger and record costs (a host from before frame-weights has no such field, and counts only). */
  weigh?: { trigger(trigger: number): number; record(record: number, type: number, action: boolean): number; reset?(): void } | null;
  report(from?: number): {
    from: number;
    conditions: number[];
    actions: number[];
    /** Of those, the records under no group. */
    ungrouped: number[];
    groups: Map<number, { conditions: number; actions: number; frames: number; peak: number; peakFrame: number; ns?: number; peakNs?: number; peakNsFrame?: number }>;
    /** Triggers passed, and what the weigher said each frame cost (nanoseconds), all and under no group: a weighing host's. */
    triggers?: number[];
    ns?: number[];
    ungroupedNs?: number[];
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
  /** The same as time in Remastered, when the host weighs: milliseconds over the run, the most in one frame and that frame. */
  ms?: { total: number; peak: number; peakFrame: number };
}

/** A test's frames as time in Remastered (milliseconds), beside the counts, when the host weighs. */
export interface TestCostMs {
  /** The script's build, a frame: its lines and the build's own triggers, as `perFrame` counts them. */
  perFrame: number[];
  /** The map's other triggers a frame, as `other`. */
  other: number[];
  peak: number;
  peakFrame: number;
}

/** What a test's run in the game cost. */
export interface TestCost {
  /** The frame `perFrame` starts at. */
  from: number;
  /** Conditions and actions a frame that the script's build ran: its lines and the build's own triggers. */
  perFrame: number[];
  /**
   * What the map's other triggers ran a frame: the start-up (once, by frame 2) and any trigger the map has besides the
   * build's. Kept apart so that the script's own peak is not that start.
   */
  other: number[];
  /** The most of `perFrame`, and the first frame it was that many. */
  peak: number;
  peakFrame: number;
  /** By line, the costliest first. */
  lines: LineCost[];
  /** Triggers the walk passed a frame, the map's other triggers included; when the host counts them. */
  triggers?: number[];
  /** The frames as time, when the host weighs. */
  ms?: TestCostMs;
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

  /** `payloadEnd`: where the build's payload ends in the game's memory (the host says; the end of `STRx`). */
  constructor(map: TriggerMap, payloadEnd: number) {
    this.payloadEnd = payloadEnd;
    this.payloadStart = payloadEnd - map.payload;
    for (const [offset, conditions, actions, origin, byAction] of map.triggers) {
      const where = lineOf(origin);
      const g = where ? this.idOf(where) : CARRY;
      const at = this.payloadStart + offset;
      for (let i = 0; i < conditions; i++) this.byRecord.set(at + 8 + 20 * i, g);
      // (A trigger holding several lines' work gives each its actions.)
      for (let i = 0; i < actions; i++) {
        const own = byAction?.[i] !== undefined ? lineOf(byAction[i]) : where;
        this.byRecord.set(at + 8 + 320 + 32 * i, own ? this.idOf(own) : g);
      }
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
    const weighed = !!tap.weigh && !!r.ns && !!r.ungroupedNs;
    const lines: LineCost[] = [];
    for (const [g, k] of r.groups) {
      const where = this.at[g];
      if (!where) continue;
      lines.push({ file: where.file, line: where.line, total: k.conditions + k.actions, peak: k.peak, peakFrame: k.peakFrame, frames: k.frames,
        ...(weighed ? { ms: { total: (k.ns ?? 0) / 1e6, peak: (k.peakNs ?? 0) / 1e6, peakFrame: k.peakNsFrame ?? k.peakFrame } } : {}) });
    }
    lines.sort(weighed ? (a, b) => b.ms!.peak - a.ms!.peak || b.ms!.total - a.ms!.total : (a, b) => b.peak - a.peak || b.total - a.total);
    const cost: TestCost = { from: r.from, perFrame, other: [...r.ungrouped], peak, peakFrame, lines, ...(r.triggers ? { triggers: [...r.triggers] } : {}) };
    if (weighed) {
      const other = r.ungroupedNs!.map((n) => n / 1e6), mine = r.ns!.map((n, i) => (n - r.ungroupedNs![i]) / 1e6);
      let top = 0, topFrame = r.from;
      mine.forEach((x, i) => { if (x > top) { top = x; topFrame = r.from + i; } });
      cost.ms = { perFrame: mine, other, peak: top, peakFrame: topFrame };
    }
    return cost;
  }
}

/** "main.ts:12:5" or "12:5" → the file and line; null for a trigger no line made ("" — or, from a build before step 17, "fn:…" and "eudplib"). */
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

/** Milliseconds, short: 0.004, 0.31, 2.7, 15. */
export function shortMs(ms: number): string {
  return ms < 0.1 ? ms.toFixed(3) : ms < 1 ? ms.toFixed(2) : ms < 10 ? ms.toFixed(1) : ms.toFixed(0);
}

/**
 * Every test's cost folded into one per line: the most a frame the line ran in any test, and the test it was in.
 * What the editor puts beside each line after a run in the game.
 */
export function costByLine(costs: { id: string; cost: TestCost }[]): (LineCost & { test: string })[] {
  const out = new Map<string, LineCost & { test: string }>();
  for (const { id, cost } of costs) for (const l of cost.lines) {
    const key = `${l.file}:${l.line}`, was = out.get(key);
    if (!was || (l.ms && was.ms ? l.ms.peak > was.ms.peak : l.peak > was.peak)) out.set(key, { ...l, test: id });
  }
  return [...out.values()];
}
