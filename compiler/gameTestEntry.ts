/**
 * `dist/gametest.js`: what a host of the lifted game imports to run a script's tests beside it (see `gameTests.ts`).
 * The plugin never loads it itself; it hands its text to the host.
 */
export { runGameTests, type GameTestPayload } from "./gameTests";
export { GameSim, readLocations, readUnitStats, type GameHandle } from "./gameSim";
export { programVariables, readVariableMap, type VariableMap } from "./gameVariables";
