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

// A held key is still held for two frames after the last message, in the game and the simulator alike: a message can go
// missing for a frame (the lifted game loses the second of every hold) and a multiplayer game carries commands in turns.
test("a key down ten frames is held on those ten and two more, and pressed once", (sim) => {
  sim.frames(4);
  for (let i = 0; i < 10; i++) sim.press("D").frames(1);
  sim.frames(8);
  expect(sim.resources(P1).ore).toBe(12);
  expect(sim.resources(P1).gas).toBe(1);
});
