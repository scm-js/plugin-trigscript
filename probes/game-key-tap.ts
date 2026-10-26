// keyPressed() is true on the frame a key goes down, once a tap, however many frames the key stays down. Found in the
// Tetris showpiece (TrigScript 4, S2): MSQC's KeyPress is every frame the key is down, and one tap of W turned the piece
// two or three times; the build now asks MSQC for KeyDown.
//   npx tsx scripts/test-game.mts probes/game-key-tap.ts
// A program first runs on frame 2. Built like a probe (Player 1 Terran, Player 2 a Zerg computer).
import { test, expect, program, setResources, keyPressed, sleep, frames, P1 } from "trigscript";

program(async () => {
  let presses = 0;
  while (true) {
    if (keyPressed(P1, "W")) { presses++; setResources(P1, "set", presses, "ore"); }
    await sleep(frames(1));
  }
}, { owner: P1 });

test("a key held down three frames is one press; let go and pressed again, another", (sim) => {
  sim.frames(4);
  for (let i = 0; i < 3; i++) sim.press("W").frames(1);
  sim.frames(4);
  expect(sim.resources(P1).ore).toBe(1);
  sim.press("W").frames(5);
  expect(sim.resources(P1).ore).toBe(2);
});
