/**
 * A script's tests run in the lifted game (TrigScript 4, A2), where the game is: beside the engine, in whatever
 * worker hosts it, with no TypeScript there. The compile hands over the script as JavaScript (`CompileResult.modules`)
 * and the names it was compiled with; this runs the modules again to register the tests, and runs each with a
 * `GameSim` over the host's `GameHandle`, the game put back to frame 0 before each. What it returns is plain data,
 * the `TestReport` the editor already shows for the simulator.
 *
 * Bundled on its own as `dist/gametest.js`, which the plugin hands to the host as text.
 */
import { ENTRY_FILE, entryOf } from "./compiler";
import { MODULE_NAME } from "./api";
import { GameSim, readLocations, type GameHandle } from "./gameSim";
import type { TriggerMap, VariableMap } from "./gameVariables";
import { CostLines } from "./gameCost";
import { RecordingHandle, type DebugHost, type DebugLimits, type DebugRecording } from "./gameDebug";
import { here, locate, runModules, type LinkedFile } from "./link";
import type { ScriptNames } from "./names";
import { Collector, createRuntime } from "./runtime";
import { isTestFile, listTests, runTests, TestRegistry, TESTING_NAMES, type TestReport, type TestResult } from "./testing";
export { mergeCopies } from "./gameCopies";
import type { SimBounds } from "./world";

export interface GameTestPayload {
  modules: [string, LinkedFile][];
  names: ScriptNames;
  /** Run only these: tests of these files, or with these ids. Absent: all. */
  files?: string[];
  ids?: string[];
  /** The map's locations as the script means them; read from the game (frame 2) when absent. */
  locations?: Record<number, SimBounds>;
  /** Where the build put each program's variables (`readVariableMap` of its log), for `sim.program()`. */
  variables?: VariableMap | null;
  /** The build's map of triggers (`readTriggerMap` of its log): with it, what each test's frames cost is read by line. */
  triggers?: TriggerMap | null;
}

/** The modules run again to register the tests: the registry, or what stopped them. */
function register(payload: GameTestPayload) {
  const linked = new Map(payload.modules);
  const collector = new Collector();
  const registry = new TestRegistry();
  const where = (err: unknown) => { const at = locate(err, linked); return at.file ? { file: at.file, line: at.line ?? 1, ...(at.column ? { column: at.column } : {}) } : null; };
  registry.where = () => where(new Error()) ?? { file: ENTRY_FILE, line: 1 };
  const runtime = { ...createRuntime(payload.names, collector), ...registry.library() };
  collector.running = true;
  const failure = runModules(linked, entryOf(linked.keys()), runtime, MODULE_NAME, { imported: TESTING_NAMES, then: [...linked.keys()].filter(isTestFile).sort() });
  collector.running = false;
  return { linked, registry, where, error: failure ? `${failure.file ?? ENTRY_FILE}:${failure.line ?? 1}: ${failure.message}` : null };
}

export function runGameTests(game: GameHandle, payload: GameTestPayload): TestReport & { error?: string } {
  const { registry, where, error } = register(payload);
  if (error) return { list: [], results: [], only: [], ms: 0, error };
  const locations = payload.locations ?? readLocations(game);
  // A test of several players runs only where the game is one of several copies, one a player (A3); one game says so.
  const several = listTests(registry).list.filter((t) => t.kind === "test" && t.players);
  const ids = game.copy ? payload.ids : payload.ids ?? listTests(registry).list.filter((t) => t.kind === "test" && !t.players).map((t) => t.id);
  // (What a frame costs, where the host counts it and knows where the payload is.)
  const costLines = payload.triggers && game.cost && game.payloadEnd ? new CostLines(payload.triggers, game.payloadEnd) : null;
  if (costLines && game.cost) game.cost.group = costLines.group;
  const report = runTests(registry, { triggers: [], sources: [], ir: [], strings: [], locate: where }, { files: payload.files, ids, makeWorld: (_as, test) => new GameSim(game, { locations, variables: payload.variables, test, costLines }) });
  if (!game.copy && !payload.ids) {
    const held: TestResult[] = several.filter((t) => !payload.files || payload.files.includes(t.file)).map((t) => ({ id: t.id, status: "skipped", message: `a test of ${t.players!.length} players runs as a copy of the game for each`, printed: [], events: [], frames: 0, ms: 0 }));
    report.results.push(...held);
  }
  return report;
}

/** What a copy of the game runs (scm-sim's `runCopies` driver): the same tests, at this copy's computer. */
export function drive(game: GameHandle, payload: GameTestPayload): TestReport & { error?: string } {
  return runGameTests(game, payload);
}


/** What `debugGameTest` is asked: the tests' payload and the one test to run. */
export interface GameDebugPayload extends GameTestPayload {
  test: string;
  limits?: DebugLimits;
}

/**
 * One test run in the game with everything written down (A5, `gameDebug.ts`): the record goes to the editor, and the
 * session stays with the host for pictures of the run's frames (`picture`). Throws when the test cannot be run so.
 */
export function debugGameTest<K, P>(game: DebugHost<K, P>, payload: GameDebugPayload): { recording: DebugRecording; picture(frame: number): { frame: number; kept: P; transfer: ArrayBuffer[] }; close(): void } {
  const { linked, registry, where, error } = register(payload);
  if (error) throw new Error(error);
  const info = listTests(registry).list.find((t) => t.id === payload.test);
  if (!info || info.kind !== "test") throw new Error(`There is no test with the id ${payload.test} in the script any more.`);
  if (info.players) throw new Error(`"${info.name}" is a test of ${info.players.length} players: the debugger runs one game, and a test of several players runs as a copy for each. Not yet.`);
  const locations = payload.locations ?? readLocations(game);
  const costLines = payload.triggers && game.cost && game.payloadEnd ? new CostLines(payload.triggers, game.payloadEnd) : null;
  if (costLines && game.cost) game.cost.group = costLines.group;
  // (The test's line from inside a step: the stack's innermost line of a file of the script.)
  const recorder = new RecordingHandle<K, P>(game, () => here(linked), payload.limits);
  const report = runTests(registry, { triggers: [], sources: [], ir: [], strings: [], locate: where }, { ids: [info.id], makeWorld: (_as, test) => new GameSim(recorder, { locations, variables: payload.variables, test, costLines }) });
  const result = report.results.find((r) => r.id === info.id) ?? { id: info.id, status: "skipped", message: "the test did not run", printed: [], events: [], frames: 0, ms: 0 } as TestResult;
  const recording = recorder.finish({ id: info.id, name: info.name, file: info.file, line: info.line }, result, costLines ? [...costLines.places] : []);
  return { recording, picture: (frame) => recorder.picture(frame), close: () => recorder.stop() };
}
