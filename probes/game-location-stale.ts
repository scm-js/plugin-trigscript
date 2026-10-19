// Bring after a location moved in the same pass (TrigScript 4, the limits; probes/location-stale.py played in
// Remastered): the game keeps Bring's counts for a location number until the pass ends or something else is asked, so
// a count after centerLocation() read the counts of where the location was. The lowering puts a Command in between.
//   npx tsx scripts/test-game.mts probes/game-location-stale.ts
import { test, expect, program, print, createUnit, centerLocation, countUnits, reserveLocation, sleep, frames, units, P1 } from "trigscript";

const HERE_X = 192, HERE_Y = 2576, THERE_X = 520;

program(() => {
  const spot = reserveLocation("the probe's box");
  centerLocation(spot, HERE_X, HERE_Y, 64, 64);
  createUnit(P1, units.TerranMarine, 4, spot);
  sleep(frames(2));
  // In one pass: here, there, here again, there again, and in a loop.
  centerLocation(spot, HERE_X, HERE_Y, 64, 64);
  const a = countUnits(P1, units.TerranMarine, spot);
  centerLocation(spot, THERE_X, HERE_Y, 64, 64);
  const b = countUnits(P1, units.TerranMarine, spot);
  centerLocation(spot, HERE_X, HERE_Y, 64, 64);
  const c = countUnits(P1, units.TerranMarine, spot);
  let seen = "";
  for (let i = 0; i < 4; i++) {
    centerLocation(spot, i % 2 === 0 ? HERE_X : THERE_X, HERE_Y, 64, 64);
    seen += `${countUnits(P1, units.TerranMarine, spot)},`;
  }
  print(`moved: ${a} ${b} ${c} ${seen}`);
  // Made in the box, asked again in the same pass.
  centerLocation(spot, THERE_X, HERE_Y, 64, 64);
  const d = countUnits(P1, units.TerranMarine, spot);
  createUnit(P1, units.TerranMarine, 1, spot);
  const e = countUnits(P1, units.TerranMarine, spot);
  print(`made: ${d} ${e}`);
});

test("a count after centerLocation counts where the location is now", (sim) => {
  sim.frames(10);
  expect(sim).toHavePrinted("moved: 4 0 4 4,0,4,0,");
});
test("a count after createUnit counts the new unit", (sim) => {
  sim.frames(10);
  expect(sim).toHavePrinted("made: 0 1");
});
