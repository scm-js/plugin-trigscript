/**
 * Waves: an example library, from examples/library in the TrigScript repository. A script imports it by its id:
 *
 *   import { announce, spawnWave } from "waves";
 *
 *   program(() => {
 *     for (let wave = 1; wave <= 5; wave++) {
 *       announce(`Wave ${wave}`);
 *       spawnWave(P2, units.ZergZergling, wave, locations.Spawn);
 *       sleep(seconds(20));
 *     }
 *   });
 */
export { announce } from "./announce";
export { spawnWave, waveSize } from "./spawn";
