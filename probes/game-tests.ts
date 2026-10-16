// TrigScript 4, A2: a script whose tests run in the lifted game as well as in the simulator.
//   npx tsx scripts/test-game.mts probes/game-tests.ts
// Each kind of thing a test does to the world or reads back from it, once: time, a typed line, a key, units placed,
// killed, given and moved, and what was printed. Built like a probe (Player 1 Terran, Player 2 a Zerg computer,
// location 1 "Home" by Player 1's base, location 2 "Away" beside it).
import { test, expect, program, displayText, setResources, chatted, keyPressed, createUnit, sleep, frames, seconds, units, P1, P2, type Location } from "trigscript";

const HOME = 1 as Location, AWAY = 2 as Location;

program(() => {
  let ticks = 0;
  while (true) {
    ticks += 1;
    setResources(P1, "set", ticks, "gas");
    if (ticks == 3) displayText("three ticks");
    sleep(seconds(1));
  }
}, { owner: P1 });

program(() => {
  while (true) {
    const m = chatted(P1, "-give {n}");
    if (m) { setResources(P1, "add", m.n, "ore"); displayText(`gave ${m.n}`); }
    if (keyPressed(P1, "Q")) { createUnit(P1, units.TerranFirebat, 1, HOME); displayText("Q: a Firebat"); }
    sleep(frames(1));
  }
}, { owner: P1 });

test("gas counts the seconds", (sim) => {
  sim.seconds(5);
  expect(sim.resources(P1).gas).toBe(5);
  expect(sim).toHavePrinted("three ticks");
});

test("a typed line gives ore", (sim) => {
  sim.frames(10);
  const before = sim.resources(P1).ore;
  sim.type("-give 250").seconds(1);
  expect(sim.resources(P1).ore).toBe(before + 250);
  expect(sim).toHavePrinted("gave 250");
});

test("a key makes a Firebat", (sim) => {
  sim.frames(10).press("Q").frames(10);
  expect(sim.count(P1, units.TerranFirebat, HOME)).toBe(1);
  expect(sim).toHavePrinted("Q: a Firebat");
});

test("units placed, killed, given and moved", (sim) => {
  const made = sim.place(P1, units.TerranMarine, HOME, 3);
  expect(made).toHaveLength(3);
  expect(made[0].hp).toBe(40);
  sim.kill(made[0]).frames(30);
  expect(made[0].alive).toBe(false);
  expect(sim.deaths(P1, units.TerranMarine)).toBe(1);
  sim.give(made[1], P2).frames(1);
  expect(made[1].owner).toBe(P2);
  sim.move(made[2], AWAY).frames(1);
  const away = sim.location(AWAY)!;
  expect(made[2].x).toBeGreaterThanOrEqual(away.left);
  expect(made[2].x).toBeLessThanOrEqual(away.right);
});
