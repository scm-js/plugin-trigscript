// The events probe (TrigScript 4, B2): does Remastered hand on what on.created / on.died / on.chat / on.key listen for?
// The events pass walks two of the game's lists of units — the visible units (0x628430) from their head, and the dying
// ones (0x62842C) whole, both ways — and reads each record's links and uniqueness byte. Ghidra (2026-10-17): Remastered
// links its dying list the other way round and hands a map that list's far end at 0x62842C, so a walk along "next" alone
// would see one death a frame there. This checks every death arrives. The lifted game passes every step.
//
// What to look for, by the second (each step says so in the middle of the screen too):
//   A   3  three Marines made by the program beside your base: "made 0" three times (0 is the Marine's number).
//   B   7  the three die: "died 0 at x, y" three times, with places near your base;
//          then two seconds later "back" three times and three new Marines, each "made 0" again.
//   C  15  two Firebats made and taken off the map without dying: "made 32" twice, then "died 32" twice.
//   D  20  your turn: train an SCV at your Command Center. "made 7" when it comes out, not when you queue it.
//          Then load and unload anything you like (a Bunker, a Dropship): nothing new should be said.
//   E  35  200 Zerglings of yours in one frame, then all killed in one frame: "E: made 200, died 200". Does the game
//          slow or stutter at either?
//   F  45  in a multiplayer game only: type "-give 100" (Enter, the line, Enter): +100 minerals. Press F7: "help".
// Host it as a multiplayer game, alone, for F; the rest also works single player.
//   npx tsx scripts/build-fixture.mts probes/events.ts fixtures/eud/events.scx
//   npx tsx scripts/test-game.mts probes/events.ts     (A to E in the lifted game)
import { test, expect, type Sim, program, print, createUnit, setResources, sleep, seconds, frames, unitsOf, on, units, P1, type Location } from "trigscript";

const HOME = 1 as Location;

program(async () => {
  let made = 0, died = 0;
  on.created((u) => { made++; if (u.type != units.ZergZergling) print(`made ${u.type}`); });
  on.died((u) => { died++; if (u.type != units.ZergZergling) print(`died ${u.type} at ${u.x}, ${u.y}`); });
  on.died(units.TerranMarine, async () => { await sleep(seconds(2)); createUnit(P1, units.TerranMarine, 1, HOME); print("back"); });
  on.chat("-give {n}", (p, { n }) => { setResources(p, "add", n, "ore"); print(`gave ${n}`, { to: p }); });
  on.key("F7", (p) => print("help", { to: p }));

  await sleep(seconds(3));
  print("A: three Marines made by the program. Expect \"made 0\" three times.", { position: "center" });
  createUnit(P1, units.TerranMarine, 3, HOME);

  await sleep(seconds(4));
  print("B: they die. Expect \"died 0 at x, y\" three times, then \"back\" and \"made 0\" three times.", { position: "center" });
  for (const u of unitsOf(P1, { type: units.TerranMarine, at: HOME })) u.kill();

  await sleep(seconds(8));
  print("C: two Firebats made, then taken off the map. Expect \"made 32\" twice, then \"died 32\" twice.", { position: "center" });
  createUnit(P1, units.TerranFirebat, 2, HOME);
  await sleep(frames(12));
  for (const u of unitsOf(P1, { type: units.TerranFirebat })) u.remove();

  await sleep(seconds(5));
  setResources(P1, "add", 100, "ore");
  print("D: train an SCV now (you have 100 more minerals). Expect \"made 7\" when it comes out. Loading and unloading should say nothing.", { position: "center" });

  await sleep(seconds(15));
  print("E: 200 Zerglings made in one frame; three seconds later all killed in one frame. Does the game slow?", { position: "center" });
  const before = made, gone = died;
  for (let i = 0; i < 8; i++) createUnit(P1, units.ZergZergling, 25, HOME);
  await sleep(seconds(3));
  for (const u of unitsOf(P1, { type: units.ZergZergling })) u.kill();
  await sleep(seconds(1));
  print(`E: made ${made - before}, died ${died - gone}`);

  await sleep(seconds(6));
  print("F: in multiplayer, type -give 100, and press F7.", { position: "center" });
}, { owner: P1, name: "events" });

/** How many times a text was shown. (The game's own lines fold the same text shown twice in a frame, so the actions are counted.) */
const said = (sim: Sim, text: string | RegExp) => sim.events.filter((e) => { const t = e.text.replace(/^Display Text Message — /, ""); return e.text !== t && (typeof text === "string" ? t === text : text.test(t)); }).length;

test("A and B: made, died where, back", (sim) => {
  sim.seconds(9);
  expect(said(sim, /^died 0 at \d+, \d+$/)).toBe(3);
  sim.seconds(3);
  expect(said(sim, "back")).toBe(3);
  expect(said(sim, "made 0")).toBe(6);
});

test("C: removed is died too", (sim) => {
  sim.seconds(19);
  expect(said(sim, "made 32")).toBe(2);
  expect(said(sim, /^died 32 at/)).toBe(2);
});

test("E: two hundred in a frame, each way", (sim) => {
  sim.seconds(44);
  expect(said(sim, "E: made 200, died 200")).toBe(1);
});
