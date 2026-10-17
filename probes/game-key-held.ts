// keyHeld() is true on every frame a key is down, and a press is still one, in the lifted game as in the simulator.
//   npx tsx scripts/test-game.mts probes/game-key-held.ts
// A program first runs on frame 2. Built like a probe (Player 1 Terran, Player 2 a Zerg computer).
import { test, expect, program, setResources, keyHeld, keyPressed, sleep, frames, P1 } from "trigscript";

program(async () => {
  let held = 0, presses = 0;
  while (true) {
    if (keyHeld(P1, "D")) held++;
    if (keyPressed(P1, "D")) presses++;
    setResources(P1, "set", held, "ore");
    setResources(P1, "set", presses, "gas");
    await sleep(frames(1));
  }
}, { owner: P1 });

// In the lifted game the first two frames' messages arrive together (MSQC), so a hold of n frames is read on n − 1 of
// them there — 1 → 1, 3 → 2, 10 → 9 — and on n in the simulator. Either way it is held from the second frame to the end.
test("a key down ten frames is held on (nearly) every one of them and pressed once", (sim) => {
  sim.frames(4);
  for (let i = 0; i < 10; i++) sim.press("D").frames(1);
  sim.frames(8);
  expect(sim.resources(P1).ore).toBeGreaterThanOrEqual(9);
  expect(sim.resources(P1).ore).toBeLessThanOrEqual(10);
  expect(sim.resources(P1).gas).toBe(1);
});
