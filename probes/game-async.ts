// TrigScript 4, B1: async functions, await, until(), Promise.all and Promise.race, run in the lifted game as well as in
// the simulator — the two have to agree frame for frame.
//   npx tsx scripts/test-game.mts probes/game-async.ts
// A program first runs on frame 2. Built like a probe (Player 1 Terran, Player 2 a Zerg computer, location 1 "Home").
import { test, expect, program, displayText, setResources, createUnit, countUnits, sleep, until, frames, units, P1, P2, type Location } from "trigscript";

const HOME = 1 as Location;

program(async () => {
  let n = 0;
  async function wave(k: number): Promise<number> {
    createUnit(P2, units.ZergZergling, k, HOME);
    await until(() => countUnits(P2, units.ZergZergling, HOME) === 0);
    return k;
  }
  // Frame 2: n is 1; frame 6: 2; frame 10: 3, and the second branch sees it in the same frame; frame 14 the first ends.
  await Promise.all([
    (async () => { for (let i = 0; i < 3; i++) { n++; setResources(P1, "set", n, "gas"); await sleep(frames(4)); } })(),
    (async () => { await until(() => n >= 3); displayText("three"); })(),
  ]);
  displayText("all done");
  // From frame 14: the second branch wins on frame 24; the third never prints.
  const w = await Promise.race([
    (async () => { await sleep(frames(20)); return 1; })(),
    sleep(frames(10)).then(() => 2),
    (async () => { await sleep(frames(30)); displayText("late"); return 3; })(),
  ]);
  setResources(P1, "set", w * 100, "ore");
  // A wave of two Zerglings the test kills, raced against a long sleep.
  const cleared = await Promise.race([wave(2), sleep(frames(500)).then(() => -1)]);
  setResources(P1, "set", cleared, "gas");
  displayText(cleared > 0 ? "wave cleared" : "wave lost");
}, { owner: P1 });

test("Promise.all: the branches side by side, until() in the frame its answer turns", (sim) => {
  sim.frames(9);
  expect(sim.resources(P1).gas).toBe(2);
  expect(sim).not.toHavePrinted("three");
  sim.frames(2);
  expect(sim.resources(P1).gas).toBe(3);
  expect(sim).toHavePrinted("three");
  expect(sim).not.toHavePrinted("all done");
  sim.frames(4);
  expect(sim).toHavePrinted("all done");
});

test("Promise.race: the first to end gives the value, the others stop", (sim) => {
  sim.frames(23);
  expect(sim.resources(P1).ore).toBe(0);
  sim.frames(1);
  expect(sim.resources(P1).ore).toBe(200);
  sim.frames(40);
  expect(sim).not.toHavePrinted("late");
});

test("an awaited wave: until() over the game's units", (sim) => {
  sim.frames(30);
  expect(sim.count(P2, units.ZergZergling, HOME)).toBe(2);
  for (const u of sim.units({ owner: P2, type: units.ZergZergling })) sim.kill(u);
  sim.frames(30);
  expect(sim.resources(P1).gas).toBe(2);
  expect(sim).toHavePrinted("wave cleared");
});
