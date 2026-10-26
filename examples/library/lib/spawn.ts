import { createUnit, type Location, type Player, type UnitType } from "trigscript";

/** How many units wave `n` has: four in the first, two more in each after it. */
export function waveSize(n: number): number {
  return 2 + n * 2;
}

/** Make wave `n`: `waveSize(n)` of `unit` for `player` at `at`. */
export function spawnWave(player: Player, unit: UnitType, n: number, at: Location) {
  createUnit(player, unit, waveSize(n), at);
}
