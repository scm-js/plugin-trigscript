// TrigScript 4: a loop over units comes to them in the order the game hands its places out — slot 0, then 1699
// downwards, the units oldest first — and stops once it has met every unit in use; in the lifted game and the simulator.
// A unit given away keeps its place; a unit killed in the loop, the loop's own or the next, leaves the rest to come; a
// unit made in the loop takes a place the walk has passed or is yet to reach, and is counted after.
//   npx tsx scripts/test-game.mts probes/game-unit-order.ts
// The map gives P1 a Command Center and four Marines, P2 a Hatchery and four Zerglings (build-fixture); location 1 is
// beside P1's base. Units are told apart by their hit points, set as they are made.
import { test, expect, program, displayText, createUnit, sleep, frames, unitsOf, unitsAt, allUnits, first, units, gas, setResources, P1, P2, P3, P5, type Location } from "trigscript";

const HOME = 1 as Location;

program(() => {
  setResources(P1, "set", 1, "gas");
  sleep(frames(2));
  // Out of the way: the map's own units are not ours to count.
  for (const u of allUnits()) u.remove();
  sleep(frames(1));
  const one = gas(P1);
  // Five Firebats for P1, one after another, numbered 1 … 5 by their hit points; two Vultures for P2 (Zerg would grow back their hit points).
  let newest = first({ owner: P5 });
  for (let i = 1; i <= 5; i++) { createUnit(P1, units.TerranFirebat, 1, HOME); let u = first({ owner: P5 }); for (const v of unitsOf(P1, { type: units.TerranFirebat })) u = v; if (u) u.hp = i * one; newest = u; }
  for (let i = 6; i <= 7; i++) { createUnit(P2, units.TerranVulture, 1, HOME); let u = first({ owner: P5 }); for (const v of unitsOf(P2, { type: units.TerranVulture })) u = v; if (u) u.hp = i * one; }
  sleep(frames(1));

  // A: P1's alone, then everybody's.
  let a = "";
  for (const u of unitsOf(P1)) a += `${u.hp}`;
  a += " ";
  for (const u of allUnits()) a += `${u.hp}`;
  displayText(`A: ${a}`);
  sleep(frames(1));

  // B: a unit given to another player keeps its place in the order.
  const h = first({ owner: P2 });
  if (h) h.give(P1);
  const f = first({ owner: P1, type: units.TerranFirebat });
  if (f) f.give(P3);
  let b = "";
  for (const u of allUnits()) b += `${u.hp}`;
  displayText(`B: ${b}`);
  sleep(frames(1));

  // C: the loop kills its own unit when it is the second, and the last Firebat (hit points 5) when it is at the
  // third, before the walk reaches it; the Marine it makes is not come to.
  let c = "";
  let k = 0;
  for (const u of unitsAt(HOME, { owner: P1 })) {
    k++;
    c += `${u.hp}`;
    if (k == 2) u.kill();
    if (k == 3 && newest) newest.kill();
    if (k == 1) createUnit(P1, units.TerranMarine, 1, HOME);
  }
  let after = 0;
  for (const u of unitsOf(P1)) after++;
  displayText(`C: ${c} ${after}`);
});

test("oldest first", (sim) => {
  sim.frames(20);
  expect(sim).toHavePrinted("A: 12345 1234567");
});
test("a unit given away keeps its place", (sim) => {
  sim.frames(20);
  expect(sim).toHavePrinted("B: 1234567");
});
test("kills in the loop, and a unit made in it", (sim) => {
  sim.frames(20);
  expect(sim).toHavePrinted("C: 2346 4");
});
