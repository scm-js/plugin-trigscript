/**
 * A test of several players in the lifted game (TrigScript 4, A3): a copy of the game for each player, each with a
 * report of its own, made into one result a test. Apart from the rest of the game's tests so that the editor takes
 * this without the compiler.
 */
import type { TestReport, TestResult } from "./testing";

/**
 * A test of several players, from each copy's report (its answer, in the order of the players): it passed when it
 * passed at every computer; the first copy that failed says why, and at whose computer. A copy that could not run
 * fails every test with what went wrong.
 */
export function mergeCopies(ids: readonly string[], copies: readonly { player: number; result: unknown; error: string | null }[]): TestResult[] {
  return ids.map((id) => {
    const each = copies.map((c) => {
      const report = c.result as (TestReport & { error?: string }) | null;
      const problem = c.error ?? report?.error ?? null;
      const r = report?.results.find((x) => x.id === id);
      return { player: c.player, r: problem || !r ? ({ id, status: "failed", message: problem ?? "the test did not run at this computer", printed: [], events: [], frames: 0, ms: 0 } as TestResult) : r };
    });
    const bad = each.find((e) => e.r.status === "failed");
    const first = each[0].r;
    const ms = Math.max(...each.map((e) => e.r.ms));
    if (!bad) return { ...first, ms };
    // (A desync fails it alike at every computer, and says whose computer is whose itself.)
    const same = each.every((e) => e.r.status === "failed" && e.r.message === bad.r.message);
    return { ...bad.r, ms, message: same ? bad.r.message : `at P${bad.player + 1}'s computer: ${bad.r.message}` };
  });
}
