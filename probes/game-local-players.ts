// B5 in two computers at once: each shows its own camera, and what P2's computer sends with sync() reaches both, while
// the two games stay in step (TrigScript 4, A3's copies, hashed every frame).
//   npx tsx scripts/test-game.mts probes/game-local-players.ts
import { test, expect, program, print, setResources, keyPressed, sleep, frames, local, sync, select, first, P1, P2, AllPlayers } from "trigscript";

// Each player's own line, on their own computer: different on each, and only shown, so the two games do not split.
program(async () => {
  let mine = 0;
  while (true) {
    mine = local.camera.x;
    if (local.mouse.x > 200) print(`camera at ${mine}, mouse right`);
    else print(`camera at ${mine}, mouse left`);
    const u = local.selected;
    if (u) print(`selected ${u.type}, P${u.owner + 1}'s`);
    await sleep(frames(1));
  }
}, { owner: AllPlayers });

program(async () => {
  while (true) {
    // P2's first unit made P2's selection: a Select command from P2's computer, run on both.
    if (keyPressed(P2, "S")) { const m = first({ owner: P2 }); if (m) select(P2, m); }
    if (keyPressed(P2, "Q")) {
      const x = await sync(P2, local.camera.x + local.mouse.x);
      setResources(P2, "set", x, "ore");
      print(`P2's mouse is at ${x}`);
    }
    await sleep(frames(1));
  }
}, { owner: P1 });

test("each computer shows its own camera, and P2's synced mouse reaches both without a split", { players: [P1, P2] }, (sim) => {
  sim.moveCamera(320, 0, P1).moveMouse(400, 100, P1);
  sim.moveCamera(1280, 640, P2).moveMouse(1500, 700, P2);
  sim.frames(6);
  expect(sim.printed(P1)).toContain("camera at 320, mouse left");
  expect(sim.printed(P2)).toContain("camera at 1280, mouse right");
  sim.press("Q", P2).frames(30);
  expect(sim.resources(P2).ore).toBe(1500);
  expect(sim.printed(P1)).toContain("P2's mouse is at 1500");
});

test("select() at P2's computer selects there, and the two games stay in step", { players: [P1, P2] }, (sim) => {
  sim.frames(6);
  sim.press("S", P2).frames(30);
  expect(sim.printed(P2).some((t) => t.startsWith("selected") && t.endsWith("P2's"))).toBe(true);
  expect(sim.printed(P1).some((t) => t.startsWith("selected"))).toBe(false);
});
