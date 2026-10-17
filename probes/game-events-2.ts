// TrigScript 4, B2 second part: on.killed, on.order and a listener at the top of a script — run in the lifted game as
// well as in the simulator; the two have to agree frame for frame. (on.morphed needs a player's command in the game,
// which a test cannot give: the simulator's tests and the Remastered probe cover it.)
//   npx tsx scripts/test-game.mts probes/game-events-2.ts
// A program first runs on frame 2. Built like a probe (Player 1 Terran, Player 2 a Zerg computer, location 1 "Home").
import { test, expect, program, print, createUnit, sleep, frames, unitsOf, on, units, orders, setResources, P1, P2, type Location } from "trigscript";

const HOME = 1 as Location;

// At the top of the script: a program of its own, listening from the start.
on.created(units.TerranGhost, (u) => print(`ghost ${u.owner}`));

program(async () => {
  let killed = 0, byP2 = 0, killer = -1, deaths = 0, moved = 0, patrols = 0, attacks = 0, from = -1;
  on.killed((u, by) => { killed++; killer = by; setResources(by, "add", 10, "ore"); });
  on.killed({ by: P2 }, () => { byP2++; });
  on.died(() => { deaths++; });
  on.order({ owner: P1, order: orders.Move }, (u, order, was) => { moved++; from = was; });
  on.order(units.TerranFirebat, orders.Patrol, () => { patrols++; });
  on.order(units.TerranFirebat, orders.AttackMove, () => { attacks++; });
  // Frame 4: two Marines and two Firebats.
  await sleep(frames(2));
  createUnit(P1, units.TerranMarine, 2, HOME);
  createUnit(P1, units.TerranFirebat, 2, HOME);
  // Frame 8: the Marines told to move, the Firebats to patrol; frame 10: to attack.
  await sleep(frames(4));
  for (const u of unitsOf(P1, { type: units.TerranMarine })) u.order("move", HOME);
  for (const u of unitsOf(P1, { type: units.TerranFirebat })) u.order("patrol", HOME);
  await sleep(frames(2));
  for (const u of unitsOf(P1, { type: units.TerranFirebat })) u.order("attack", HOME);
}, { owner: P1, name: "events2" });

test("on.killed: a death in a fight with its killer; a death by a program is not one", (sim) => {
  sim.frames(5);
  const [a, b] = sim.units({ owner: P1, type: units.TerranMarine });
  sim.kill(a, P2);
  sim.frames(1);
  expect(sim.program("events2").killed).toBe(1);
  expect(sim.program("events2").killer).toBe(P2);
  expect(sim.program("events2").byP2).toBe(1);
  expect(sim.resources(P2).ore).toBe(10);
  // Killed without a killer: a death, not a kill.
  sim.kill(b);
  sim.frames(1);
  expect(sim.program("events2").killed).toBe(1);
  expect(sim.program("events2").deaths).toBe(2);
});

test("on.order: the order a unit took up, and the one it had", (sim) => {
  sim.frames(9);
  // Every Marine of Player 1's, the two made and the base's own.
  expect(sim.program("events2").moved).toBe(sim.count(P1, units.TerranMarine));
  expect(sim.program("events2").from).toBe(orders.PlayerGuard);
  expect(sim.program("events2").patrols).toBe(2);
  sim.frames(2);
  expect(sim.program("events2").attacks).toBe(2);
});

test("a listener at the top of a script", (sim) => {
  sim.frames(3);
  sim.place(P1, units.TerranGhost, HOME, 3);
  sim.frames(1);
  expect(sim.printed().filter((t) => t === "ghost 0").length).toBeGreaterThan(0);
});
