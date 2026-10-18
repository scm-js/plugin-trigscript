// The second events probe (TrigScript 4, B2, second part): does Remastered hand on what on.killed, on.order and
// on.morphed listen for, and does a listener at the top of a script listen?
// on.killed reads two fields of the dying record: hit points (+0x08) and the last player whose attack hurt the unit
// (+0x90); the lifted game leaves 0 and the killer there after a fight, its hit points and 8 after Kill Unit. on.order and
// on.morphed walk the visible units every frame and compare each one's order byte (+0x4D) and type (+0x64) with a table of
// their own. Everything read is allowed by Remastered's emulator (the dump, R0); none of it has been played.
//
// What to look for, by the second (each step says so in the middle of the screen too):
//   A   3  a fight beside your base: six Marines of yours, four Zerglings of the computer's. Each Zergling that falls says
//          "killed 37 by P1" and gives you 25 minerals; a Marine that falls says "killed 0 by P2", and also
//          "top: Marine down" (that one is a listener at the top of the script).
//   B  12  two Firebats killed by the program: "died 32" twice, and no "killed".
//   C  15  your turn, at your own pace: two High Templar with Psionic Storm and full energy, and a Siege Tank with Siege
//          Mode, beside your base. Type -storm: eight Zerglings of yours beside your base, standing still. Storm them.
//          "Storm!" when a Templar starts casting; "killed 37 by P1" for each Zergling the storm kills.
//          Then merge the two Templar into an Archon: "morphed 67 -> 68", and "died 67" for the other one.
//   D      siege the tank: "morphed 5 -> 30"; unsiege it: "morphed 30 -> 5".
//   E      type -zerg: two Drones beside your base and 1000 minerals. Make one a Hatchery anywhere it fits: "morphed
//          41 -> 131" when it starts. When the Hatchery is done (about 80 seconds), make a Larva a Drone: "morphed
//          35 -> 36" (the egg) at once, then "morphed 36 -> 41" when it hatches.
//   F      right-click a Marine somewhere: "move from 3" (3 is standing guard). Hold position, stop, patrol: nothing.
//   G      type -many: 300 Overlords of yours in one frame, with every unit's order and type looked at each frame.
//          Does the game slow? Type -clear to take them off again.
// Host it as a multiplayer game, alone: a typed line (-storm, -zerg, -many) reaches the map only there.
//   npx tsx scripts/build-fixture.mts probes/events-2.ts fixtures/eud/events-2.scx
//   npx tsx scripts/test-game.mts probes/events-2.ts     (A and B in the lifted game)
import { test, expect, type Sim, program, print, createUnit, setResources, sleep, seconds, unitsOf, on, units, orders, techs, stats, P1, P2, type Location } from "trigscript";

const HOME = 1 as Location;

// At the top of the script: a program of its own, listening from the start of the game.
on.died(units.TerranMarine, () => print("top: Marine down"));

program(async () => {
  stats(P1).researched[techs.PsionicStorm] = true;
  stats(P1).researched[techs.TankSiegeMode] = true;
  on.killed((u, by) => print(`killed ${u.type} by P${by + 1}`));
  on.killed({ by: P1 }, () => setResources(P1, "add", 25, "ore"));
  on.died((u) => { if (u.type != units.TerranMarine && u.type != units.ZergZergling && u.type != units.ZergOverlord) print(`died ${u.type}`); });
  on.created(units.ProtossHighTemplar, (u) => { u.energy = 200; });
  on.order(units.ProtossHighTemplar, orders.CastPsionicStorm, () => print("Storm!"));
  on.order({ owner: P1, type: units.TerranMarine, order: orders.Move }, (u, order, was) => print(`move from ${was}`));
  on.morphed({ owner: P1 }, (u, was) => print(`morphed ${was} -> ${u.type}`));
  // (Your own Zerglings stand still where you can see them: the computer's at Away were made in the dark, and the
  // neutral player's were not made in Remastered.)
  on.chat("-storm", () => { print("-storm: eight Zerglings"); createUnit(P1, units.ZergZergling, 8, HOME); });
  on.chat("-zerg", () => { print("-zerg: two Drones"); setResources(P1, "add", 1000, "ore"); createUnit(P1, units.ZergDrone, 2, HOME); });
  on.chat("-many", () => { print("-many: 300 Overlords"); for (let i = 0; i < 12; i++) createUnit(P1, units.ZergOverlord, 25, HOME); });
  on.chat("-clear", () => { print("-clear"); for (const u of unitsOf(P1, { type: units.ZergOverlord })) u.remove(); });

  await sleep(seconds(3));
  print("A: a fight. Expect \"killed 37 by P1\" for each Zergling (25 minerals each), \"killed 0 by P2\" and \"top: Marine down\" for each Marine.", { position: "center" });
  createUnit(P1, units.TerranMarine, 6, HOME);
  createUnit(P2, units.ZergZergling, 4, HOME);

  await sleep(seconds(9));
  print("B: two Firebats killed by the program. Expect \"died 32\" twice and no \"killed\".", { position: "center" });
  createUnit(P1, units.TerranFirebat, 2, HOME);
  await sleep(seconds(1));
  for (const u of unitsOf(P1, { type: units.TerranFirebat })) u.kill();

  await sleep(seconds(2));
  createUnit(P1, units.ProtossHighTemplar, 2, HOME);
  createUnit(P1, units.TerranSiegeTankTankMode, 1, HOME);
  print("C to F: your turn. -storm for Zerglings to storm, then an Archon, siege the tank, -zerg for a Hatchery and a Drone, move a Marine. See the answer sheet.", { position: "center" });
}, { owner: P1, name: "events2" });

/** How many times a text was shown. (The game's own lines fold the same text shown twice in a frame, so the actions are counted.) */
const said = (sim: Sim, text: string | RegExp) => sim.events.filter((e) => { const t = e.text.replace(/^Display Text Message — /, ""); return e.text !== t && (typeof text === "string" ? t === text : text.test(t)); }).length;

test("B: a program's kill is a death, not a kill", (sim) => {
  sim.seconds(14);
  expect(said(sim, "died 32")).toBe(2);
  expect(said(sim, /^killed 32/)).toBe(0);
});
