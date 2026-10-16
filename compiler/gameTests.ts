/**
 * A script's tests run in the lifted game (TrigScript 4, A2), where the game is: beside the engine, in whatever
 * worker hosts it, with no TypeScript there. The compile hands over the script as JavaScript (`CompileResult.modules`)
 * and the names it was compiled with; this runs the modules again to register the tests, and runs each with a
 * `GameSim` over the host's `GameHandle`, the game put back to frame 0 before each. What it returns is plain data,
 * the `TestReport` the editor already shows for the simulator.
 *
 * Bundled on its own as `dist/gametest.js`, which the plugin hands to the host as text.
 */
import { ENTRY_FILE } from "./compiler";
import { MODULE_NAME } from "./api";
import { GameSim, readLocations, type GameHandle } from "./gameSim";
import type { TriggerMap, VariableMap } from "./gameVariables";
import { CostLines } from "./gameCost";
import { locate, runModules, type LinkedFile } from "./link";
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

export function runGameTests(game: GameHandle, payload: GameTestPayload): TestReport & { error?: string } {
  const linked = new Map(payload.modules);
  const collector = new Collector();
  const registry = new TestRegistry();
  const where = (err: unknown) => { const at = locate(err, linked); return at.file ? { file: at.file, line: at.line ?? 1, ...(at.column ? { column: at.column } : {}) } : null; };
  registry.where = () => where(new Error()) ?? { file: ENTRY_FILE, line: 1 };
  const runtime = { ...createRuntime(payload.names, collector), ...registry.library() };
  collector.running = true;
  const failure = runModules(linked, ENTRY_FILE, runtime, MODULE_NAME, { imported: TESTING_NAMES, then: [...linked.keys()].filter(isTestFile).sort() });
  collector.running = false;
  if (failure) return { list: [], results: [], only: [], ms: 0, error: `${failure.file ?? ENTRY_FILE}:${failure.line ?? 1}: ${failure.message}` };
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

