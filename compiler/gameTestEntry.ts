/**
 * `dist/gametest.js`: what a host of the lifted game imports to run a script's tests beside it (see `gameTests.ts`).
 * The plugin never loads it itself; it hands its text to the host.
 */
export { drive, runGameTests, type GameTestPayload } from "./gameTests";
export { mergeCopies } from "./gameCopies";
export { desyncMessage, GameSim, readLocations, readUnitStats, type Desync, type GameCopy, type GameHandle } from "./gameSim";
export { programVariables, readVariableMap, type VariableMap } from "./gameVariables";
