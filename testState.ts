/**
 * What the workspace shows of the script's tests, worked out from a compile's report: the
 * results kept from one run to the next, a test's and a `describe`'s mark, what is said at
 * the end of a failing line, the warnings for Problems, and the Testing view's tree —
 * folder, file, `describe`, test. Pure over the report, so the tests need no editor.
 */
import type { TestInfo, TestReport, TestResult } from "./compiler/testing";
import type { ScriptWarning, TestMark, TestNote } from "./monaco";
import { buildTree, type TreeNode } from "./tree";

export type TestStateName = TestMark["state"];

export interface TestState {
  list: TestInfo[];
  /** By test id: the last result of each test the script still has. */
  results: Map<string, TestResult>;
  only: TestReport["only"];
}

export const NO_TESTS: TestState = { list: [], results: new Map(), only: [] };

/**
 * The state after a report. A run of some tests leaves the others' results as they were; a
 * report that only lists (the script has problems elsewhere, or nothing asked for a run)
 * leaves them all. A result whose test is gone goes with it.
 */
export function mergeReport(before: TestState, report: TestReport | null): TestState {
  if (!report) return NO_TESTS;
  const ids = new Set(report.list.map((t) => t.id));
  const results = new Map([...before.results].filter(([id]) => ids.has(id)));
  for (const r of report.results) results.set(r.id, r);
  return { list: report.list, results, only: report.only };
}

export interface TestCounts { total: number; passed: number; failed: number; skipped: number; notRun: number }

export function countTests(state: TestState, under?: (t: TestInfo) => boolean): TestCounts {
  const c: TestCounts = { total: 0, passed: 0, failed: 0, skipped: 0, notRun: 0 };
  for (const t of state.list) {
    if (t.kind !== "test" || (under && !under(t))) continue;
    c.total++;
    const r = state.results.get(t.id);
    if (!r) c.notRun++;
    else c[r.status]++;
  }
  return c;
}

/** Failed when any of them failed, passed when all that ran passed, skipped when all were skipped, else not run. */
export const stateOfCounts = (c: TestCounts): TestStateName => (c.failed ? "failed" : c.total === 0 || c.notRun === c.total ? "none" : c.passed ? "passed" : c.skipped ? "skipped" : "none");

/** Whether `t` is under the suite `suite`. */
const inside = (suite: TestInfo) => (t: TestInfo) => t.id === suite.id || t.id.startsWith(`${suite.id} > `);

export function stateOf(state: TestState, info: TestInfo): TestStateName {
  if (info.kind === "suite") return stateOfCounts(countTests(state, inside(info)));
  return state.results.get(info.id)?.status ?? "none";
}

const STATE_WORDS: Record<TestStateName, string> = { none: "Not run yet", passed: "Passed", failed: "Failed", skipped: "Skipped", running: "Running…" };

export function marksOf(state: TestState): TestMark[] {
  return state.list.map((info) => {
    const s = stateOf(state, info);
    const r = state.results.get(info.id);
    return { file: info.file, line: info.line, state: s, id: info.id, title: `${STATE_WORDS[s]}${r?.status === "failed" && r.message ? `: ${r.message}` : ""} — click to run ${info.kind === "suite" ? "these tests" : "this test"}` };
  });
}

/** A failure is said where it is: at the end of the failing `expect`'s line, the two values in full on hover. */
export function notesOf(state: TestState): TestNote[] {
  const notes: TestNote[] = [];
  for (const info of state.list) {
    const r = state.results.get(info.id);
    if (r?.status !== "failed") continue;
    const at = r.at ?? { file: info.file, line: info.line };
    const hover = r.expected !== undefined || r.actual !== undefined ? `**${info.name}**\n\nExpected: \`${r.expected ?? "—"}\`\n\nGot: \`${r.actual ?? "—"}\`` : `**${info.name}**\n\n${r.message ?? "failed"}`;
    notes.push({ file: at.file, line: at.line, text: r.message ?? "failed", hover });
  }
  return notes;
}

/** A failing test is a warning at its line; so is a `test.only` left in. */
export function warningsOf(state: TestState): ScriptWarning[] {
  const out: ScriptWarning[] = [];
  for (const info of state.list) {
    const r = state.results.get(info.id);
    if (info.kind === "test" && r?.status === "failed") out.push({ file: info.file, line: info.line, message: `The test "${info.name}" fails: ${r.message ?? "failed"}` });
  }
  for (const o of state.only) out.push({ file: o.file, line: o.line, message: "An only is left in: the other tests of this file do not run." });
  return out;
}

/* ── The Testing view's tree ── */

export type TestNode =
  | { kind: "folder"; name: string; path: string; children: TestNode[] }
  | { kind: "file"; name: string; path: string; children: TestNode[] }
  | { kind: "suite" | "test"; info: TestInfo; children: TestNode[] };

/** Folder, file, `describe`, test; only the files that have tests, and the folders those are in. */
export function testTree(list: TestInfo[]): TestNode[] {
  const files = [...new Set(list.map((t) => t.file))];
  const under = (file: string): TestNode[] => {
    const mine = list.filter((t) => t.file === file);
    const build = (path: string[]): TestNode[] => mine
      .filter((t) => t.path.length === path.length && t.path.every((p, i) => p === path[i]))
      .map((info) => ({ kind: info.kind, info, children: info.kind === "suite" ? build([...path, info.name]) : [] }));
    return build([]);
  };
  const walk = (nodes: TreeNode[]): TestNode[] => nodes.map((n) => (n.kind === "folder"
    ? { kind: "folder" as const, name: n.name, path: n.path, children: walk(n.children) }
    : { kind: "file" as const, name: n.name, path: n.path, children: under(n.path) }));
  return walk(buildTree(files));
}

/** The ids a node of the tree runs. */
export function idsUnder(node: TestNode): string[] {
  if (node.kind === "test" || node.kind === "suite") return [node.info.id];
  return node.children.flatMap(idsUnder);
}

/** "P1–P8", "P1, P3": who a line is for, runs of neighbours as a range. */
export function playersLabel(players: readonly number[]): string {
  const sorted = [...new Set(players)].sort((a, b) => a - b);
  const parts: string[] = [];
  for (let i = 0; i < sorted.length; i++) {
    let j = i;
    while (j + 1 < sorted.length && sorted[j + 1] === sorted[j] + 1) j++;
    parts.push(j - i >= 2 ? `P${sorted[i] + 1}–P${sorted[j] + 1}` : sorted.slice(i, j + 1).map((p) => `P${p + 1}`).join(", "));
    i = j;
  }
  return parts.join(", ");
}

/**
 * The lines of one frame that say the same thing from the same place for several players, as one line for all of
 * them: a trigger of All Players in a game of eight is one row, not eight. The first of them keeps its place.
 */
export function foldPlayers<T extends { frame: number; text: string; player: number; file?: string; line?: number }>(events: readonly T[]): (T & { players: number[] })[] {
  const out: (T & { players: number[] })[] = [];
  const seen = new Map<string, T & { players: number[] }>();
  for (const e of events) {
    const key = `${e.frame}|${e.file ?? ""}|${e.line ?? 0}|${e.text}`;
    const first = seen.get(key);
    if (first) { if (!first.players.includes(e.player)) first.players.push(e.player); continue; }
    const row = { ...e, players: [e.player] };
    seen.set(key, row);
    out.push(row);
  }
  return out;
}

/** What the status bar says: `12 passed`, `1 failed`, and what is left over. */
export function summary(c: TestCounts): { text: string; failed: boolean } | null {
  if (c.total === 0) return null;
  if (c.failed) return { text: `${c.failed} failed${c.passed ? `, ${c.passed} passed` : ""}`, failed: true };
  if (c.notRun === c.total) return { text: `${c.total} test${c.total === 1 ? "" : "s"}`, failed: false };
  return { text: `${c.passed} passed${c.skipped ? `, ${c.skipped} skipped` : ""}${c.notRun ? `, ${c.notRun} not run` : ""}`, failed: false };
}
