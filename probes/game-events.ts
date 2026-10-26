// TrigScript 4, B2: events — on.created, on.died, a handler that waits, cancel() — run in the lifted game as well as in the
// simulator; the two have to agree frame for frame.
//   npx tsx scripts/test-game.mts probes/game-events.ts
// A program first runs on frame 2. Built like a probe (Player 1 Terran, Player 2 a Zerg computer, location 1 "Home").
import { test, expect, program, print, createUnit, sleep, frames, unitsOf, on, units, CurrentPlayer, P1, P2, type Location } from "trigscript";

const HOME = 1 as Location;

program(async () => {
  let made = 0, marines = 0, gone = 0, removed = 0, back = 0;
  on.created({ owner: P1 }, () => { made++; });
  on.created(units.TerranMarine, (u) => { marines++; u.hp = 20; });
  const died = on.died({ owner: P1, type: units.TerranMarine }, async (u) => {
    gone++;
    print(`gone at ${u.x}`);
    await sleep(frames(4));
    createUnit(u.owner, u.type, 1, HOME);
    back++;
  });
  on.died(units.TerranFirebat, () => { removed++; });
  // Frame 4: three Marines and two Firebats; the handlers see them on frame 5.
  await sleep(frames(2));
  createUnit(P1, units.TerranMarine, 3, HOME);
  createUnit(P1, units.TerranFirebat, 2, HOME);
  // Frame 8: the Marines die, the Firebats are removed. Each death is handed on once.
  await sleep(frames(4));
  for (const u of unitsOf(P1, { type: units.TerranMarine, at: HOME })) u.kill();
  for (const u of unitsOf(P1, { type: units.TerranFirebat })) u.remove();
  // Frame 20: no more listening for deaths; a Marine killed now comes back no more.
  await sleep(frames(12));
  died.cancel();
  for (const u of unitsOf(P1, { type: units.TerranMarine, at: HOME })) u.kill();
}, { owner: P1, name: "events" });

// A program for two players: each has its own listener, and CurrentPlayer in the filter is that player.
program(async () => {
  let mine = 0;
  on.created({ owner: CurrentPlayer, type: units.ZergOverlord }, () => { mine++; });
  await sleep(frames(2));
  createUnit(CurrentPlayer, units.ZergOverlord, 2, HOME);
}, { owner: [P1, P2], name: "each" });

test("a listener for each player: each sees its own", (sim) => {
  sim.frames(5);
  expect(sim.program("each", P1).mine).toBe(2);
  expect(sim.program("each", P2).mine).toBe(2);
});

test("on.created sees what was made, in the next frame, filtered", (sim) => {
  sim.frames(4);
  expect(sim.program("events").made).toBe(0);
  sim.frames(1);
  // Five of this program's, and the two Overlords the program below makes for Player 1.
  expect(sim.program("events").made).toBe(7);
  expect(sim.program("events").marines).toBe(3);
  expect(sim.units({ owner: P1, type: units.TerranMarine, at: HOME }).map((u) => u.hp)).toEqual([20, 20, 20]);
});

test("on.died: each death once, the unit as it died, a handler that waits", (sim) => {
  sim.frames(9);
  expect(sim.program("events").gone).toBe(3);
  expect(sim.program("events").removed).toBe(2);
  expect(sim).toHavePrinted(/^gone at \d+$/);
  sim.frames(4);
  expect(sim.program("events").back).toBe(3);
  expect(sim.count(P1, units.TerranMarine, HOME)).toBe(3);
  // The three that came back are new, and are seen as made in the frame after.
  expect(sim.program("events").marines).toBe(3);
  sim.frames(1);
  expect(sim.program("events").marines).toBe(6);
});

test("cancel() stops listening", (sim) => {
  sim.frames(30);
  expect(sim.program("events").gone).toBe(3);
  expect(sim.count(P1, units.TerranMarine, HOME)).toBe(0);
});
