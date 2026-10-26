// TrigScript 4: the cutscene library, in the lifted game and the simulator.
//   npx tsx scripts/test-game.mts probes/game-cutscene.ts
// Built like a probe (Player 1 Terran, Player 2 a Zerg computer, location 1 "Home"). A program first runs on frame 2.
// The simulator has no pathing: a Move order leaves a unit where it is there, so "walked" is the lifted game's to say.
import { test, expect, program, print, createUnit, first, start, sleep, frames, units, local, P1, type Location, type Unit } from "trigscript";
import { Camera, walk, line, play, SECOND } from "trigscript/cutscene";

const HOME = 1 as Location;

async function scene(raider: Unit) {
  const ox = raider.x, oy = raider.y;
  const cam = new Camera(ox, oy);
  await line(units.TerranMarine, "A: something is moving out there", SECOND);
  const x = raider.x + 96;
  const got = await walk(raider, x, raider.y, 24, 4 * SECOND);
  print(`B: ${got ? "walked" : "stayed"}`);
  await cam.pan(ox + 640, oy + 320, SECOND);
  await sleep(frames(2));
  print(`C: ${cam.x - ox} ${cam.y - oy}`);
  await cam.shake(6);
  print(`D: ${cam.x - ox} ${cam.y - oy}`);
}

async function long() {
  let n = 0;
  while (n < 100) { await sleep(frames(1)); n++; }
  print("E: not skipped");
}

program(async () => {
  createUnit(P1, units.TerranMarine, 1, HOME);
  await sleep(frames(1));
  const raider = first({ owner: P1, type: units.TerranMarine });
  if (raider) {
    const played = await play(P1, start(scene(raider)));
    print(`played ${played ? "skipped" : "whole"}`);
    const skipped = await play(P1, start(long()));
    print(`E: ${skipped ? "skipped" : "whole"} ${local.camera.x >= 0 ? "camera" : "?"}`);
  } else print("no marine");
});

test("a line", (sim) => {
  sim.frames(60);
  expect(sim).toHavePrinted("A: something is moving out there");
});
test("the camera glides and shakes, and settles where it was", (sim) => {
  sim.frames(200);
  expect(sim).toHavePrinted("C: 640 320");
  expect(sim).toHavePrinted("D: 640 320");
  expect(sim).toHavePrinted("played whole");
});
test("Escape skips a scene", (sim) => {
  sim.until(() => sim.printed().includes("played whole"), 400).frames(10);
  sim.press("Escape").frames(20);
  expect(sim).toHavePrinted("E: skipped camera");
});
