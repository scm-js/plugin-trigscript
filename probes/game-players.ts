// TrigScript 4, A3: tests of several players, each at a computer of their own — a copy of the lifted game for each,
// kept in step, every machine's commands handed to all.
//   npx tsx scripts/test-game.mts probes/game-players.ts
// A key pressed and a line typed at Player 2's computer reach Player 1's; a text made for one player is seen by
// that player only; and none of it splits the two games. Built like a probe (location 1 "Home" by Player 1's base).
import { test, expect, program, displayText, setResources, chatted, keyPressed, createUnit, sleep, frames, seconds, units, P1, P2, type Location } from "trigscript";

const HOME = 1 as Location;

program(() => {
  while (true) {
    if (keyPressed(P2, "Q")) { createUnit(P2, units.TerranFirebat, 1, HOME); displayText("P2 pressed Q"); }
    const m = chatted(P2, "-give {n}");
    if (m) { setResources(P2, "add", m.n, "ore"); displayText(`P2 was given ${m.n}`); }
    sleep(frames(1));
  }
}, { owner: P1 });

program(() => {
  let n = 0;
  while (true) {
    n += 1;
    displayText(`second ${n}, for two only`);
    sleep(seconds(1));
  }
}, { owner: P2 });

test("a key at P2's computer reaches every computer", { players: [P1, P2] }, (sim) => {
  sim.frames(10).press("Q", P2).frames(10);
  expect(sim.count(P2, units.TerranFirebat, HOME)).toBe(1);
  expect(sim.printed(P1)).toContain("P2 pressed Q");
});

test("a line typed at P2's computer", { players: [P1, P2] }, (sim) => {
  sim.frames(10);
  const before = sim.resources(P2).ore;
  sim.type("-give 75", P2).seconds(1);
  expect(sim.resources(P2).ore).toBe(before + 75);
  expect(sim.printed(P1)).toContain("P2 was given 75");
});

test("a text made for one player is that player's", { players: [P1, P2] }, (sim) => {
  sim.seconds(3);
  expect(sim.printed(P2)).toContain("second 2, for two only");
  expect(sim.printed(P1)).not.toContain("second 2, for two only");
});

test("one computer, as before", (sim) => {
  sim.frames(10).press("Q").frames(10);
  expect(sim.count(P2, units.TerranFirebat, HOME)).toBe(0);
});
