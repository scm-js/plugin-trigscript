/** `testState.ts`: what the workspace shows of a compile's test report. */
import { describe, expect, it } from "vitest";
import type { TestInfo, TestReport, TestResult } from "../compiler/testing";
import { countTests, idsUnder, marksOf, mergeReport, NO_TESTS, notesOf, stateOf, summary, testTree, warningsOf } from "../testState";

const info = (file: string, path: string[], name: string, line: number, kind: "suite" | "test" = "test"): TestInfo => ({ id: `${file}::${[...path, name].join(" > ")}`, kind, name, path, file, line, mode: "run" });
const result = (id: string, status: TestResult["status"], extra: Partial<TestResult> = {}): TestResult => ({ id, status, printed: [], events: [], frames: 0, ms: 1, ...extra });
const LIST = [info("main.ts", [], "waves", 3, "suite"), info("main.ts", ["waves"], "first", 4), info("main.ts", ["waves"], "second", 9), info("tests/ai/bases.test.ts", [], "expands", 2)];
const report = (results: TestResult[], list = LIST): TestReport => ({ list, results, only: [], ms: 5 });

describe("the results from one run to the next", () => {
  it("a run of some tests leaves the others' results, and a test that is gone takes its result with it", () => {
    let state = mergeReport(NO_TESTS, report([result(LIST[1].id, "passed"), result(LIST[2].id, "failed", { message: "expected 8, got 6" }), result(LIST[3].id, "passed")]));
    state = mergeReport(state, report([result(LIST[2].id, "passed")]));
    expect(countTests(state)).toEqual({ total: 3, passed: 3, failed: 0, skipped: 0, notRun: 0 });
    state = mergeReport(state, report([], LIST.slice(0, 3)));
    expect([...state.results.keys()]).toEqual([LIST[1].id, LIST[2].id]);
    expect(mergeReport(state, null)).toBe(NO_TESTS);
  });
});

describe("what is shown", () => {
  const state = mergeReport(NO_TESTS, { ...report([result(LIST[1].id, "passed"), result(LIST[2].id, "failed", { message: "expected 8, got 6", expected: "8", actual: "6", at: { file: "main.ts", line: 11 } })]), only: [{ file: "main.ts", line: 9 }] });
  it("a describe is what its tests are; a test that has not run has no mark yet", () => {
    expect(LIST.map((t) => stateOf(state, t))).toEqual(["failed", "passed", "failed", "none"]);
    expect(marksOf(state).map((m) => [m.line, m.state])).toEqual([[3, "failed"], [4, "passed"], [9, "failed"], [2, "none"]]);
  });
  it("a failure is said at the line that failed, a warning at the test's own, and an only is a warning too", () => {
    expect(notesOf(state)).toEqual([{ file: "main.ts", line: 11, text: "expected 8, got 6", hover: expect.stringContaining("Expected: `8`") }]);
    expect(warningsOf(state).map((w) => [w.line, w.message])).toEqual([[9, 'The test "second" fails: expected 8, got 6'], [9, expect.stringMatching(/only is left in/)]]);
  });
  it("the status bar's words", () => {
    expect(summary(countTests(state))).toEqual({ text: "1 failed, 1 passed", failed: true });
    expect(summary(countTests(mergeReport(NO_TESTS, report([result(LIST[1].id, "passed"), result(LIST[2].id, "skipped")]))))).toEqual({ text: "1 passed, 1 skipped, 1 not run", failed: false });
    expect(summary(countTests(NO_TESTS))).toBeNull();
  });
  it("the tree: folder, file, describe, test", () => {
    const shape = (nodes: ReturnType<typeof testTree>): unknown[] => nodes.map((n) => [n.kind === "folder" || n.kind === "file" ? n.path : n.info.name, shape(n.children)]);
    expect(shape(testTree(LIST))).toEqual([["tests", [["tests/ai", [["tests/ai/bases.test.ts", [["expands", []]]]]]]], ["main.ts", [["waves", [["first", []], ["second", []]]]]]]);
    expect(idsUnder(testTree(LIST)[1])).toEqual([LIST[0].id]);
  });
});
