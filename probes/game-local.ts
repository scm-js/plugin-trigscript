// B5: what only this computer knows, read in the lifted game as in the simulator, and sync() carrying one player's value
// to every computer through MSQC.
//   npx tsx scripts/test-game.mts probes/game-local.ts
// A program first runs on frame 2. Built like a probe (Player 1 Terran, Player 2 a Zerg computer).
import { test, expect, program, print, setResources, keyPressed, sleep, frames, local, sync, P1 } from "trigscript";

// The camera and the mouse on the screen, as ore and gas every frame: shown would do, but a test reads numbers.
program(async () => {
  let seen = 0;
  while (true) {
    // Kept in a variable of its own and only printed: a Local value may be shown.
    seen = local.camera.x + local.mouse.x;
    print(`camera ${local.camera.x},${local.camera.y} mouse ${local.mouse.x},${local.mouse.y} at ${seen}`);
    if (keyPressed(P1, "Q")) {
      const x = await sync(P1, local.camera.x + local.mouse.x);
      const y = await sync(P1, local.camera.y + local.mouse.y);
      setResources(P1, "set", x, "ore");
      setResources(P1, "set", y, "gas");
    }
    await sleep(frames(1));
  }
}, { owner: P1 });

test("the mouse's place on the map, sent from Player 1's computer, arrives as the same numbers", (sim) => {
  sim.frames(4);
  sim.moveCamera(640, 320).moveMouse(700, 400).frames(2);
  sim.press("Q").frames(30);
  expect(sim.resources(P1).ore).toBe(700);
  expect(sim.resources(P1).gas).toBe(400);
});

test("a camera moved again is what the next sync sends", (sim) => {
  sim.frames(4);
  sim.moveCamera(0, 0).moveMouse(100, 50).frames(2);
  sim.moveCamera(1000, 900).frames(2);
  sim.press("Q").frames(30);
  expect(sim.resources(P1).ore).toBe(100);
  expect(sim.resources(P1).gas).toBe(50);
});
