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
import type { VariableMap } from "./gameVariables";
import { locate, runModules, type LinkedFile } from "./link";
import type { ScriptNames } from "./names";
import { Collector, createRuntime } from "./runtime";
import { isTestFile, runTests, TestRegistry, TESTING_NAMES, type TestReport } from "./testing";
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
  return runTests(registry, { triggers: [], sources: [], ir: [], strings: [], locate: where }, { files: payload.files, ids: payload.ids, makeWorld: () => new GameSim(game, { locations, variables: payload.variables }) });
}
