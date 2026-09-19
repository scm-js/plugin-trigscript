// TrigScript 3.3's probe (slice 3): units on the map as objects — loops, picks, fields, verbs — and stats().
// Play it alone (Use Map Settings): you are Player 1, Terran, with a Command Center and four Marines;
// Player 2 is a computer, Zerg, in the other force. "Home" is the ground next to your base, "Away" a
// smaller box beside it. Every line says what it expects, so a wrong number or a missing effect shows.
//
//   2 s  A  three Marines appear at Home; a loop counts them (3) and adds their hit points (120)
//   5 s  B  the loop writes hit points: select the three — 20 / 40 each
//   8 s  C  nearest() + order(): ONE Marine walks to Away, the others stay
//  13 s  D  the unit kept in a variable across the sleeps: its x has changed
//  15 s  E  kill(): the runner dies; then "if (runner)" is 0 and its hit points read 0
//  18 s  F  damage(15), heal({ percent: 50 }): a Marine at Home goes 20 → 5 → 25
//  21 s  G  four Zerglings attack Home; the Marines there are invincible and lose nothing
//  29 s  H  give(): ONE Zergling turns your colour; remove(): the rest vanish without a death
//  32 s  I  the classes: your Men and your Buildings, counted
//  35 s  J  randomUnit(): three draws among your Men, their x printed — not always the same one
//  38 s  K  a function returning a unit (the weakest of your Men: F's Marine, taken down to 15) and ==
//  41 s  L  locate(): Away jumps onto your Command Center, and a Firebat appears THERE
//  44 s  M  energy, kills and a timer: a Ghost appears at Home with 250 energy, 7 kills (its rank changes) and lockdown — it cannot move for about half a minute
//  47 s  N  stats(): read back 10 / 26 / 3 / 1, and a flag 1 / 0; select a Marine: its weapon shows +3
//  50 s  O  stats(): you turn GREEN (units and minimap); Zerglings are called "Dog" (one appears at Home — select it)
//  53 s  P  stats(): speed 12 — a new Marine RUNS to Away, far faster than the first did
//  58 s  Q  the per-player program: each player keeps a unit of their own; yours is printed once
//
// Built with `npx tsx scripts/build-fixture.mts probes/units.ts fixtures/eud/units.scx`.
import { trigger, program, always, displayText, createUnit, sleep, seconds, unitsAt, unitsOf, allUnits, first, nearest, randomUnit, stats, colors, units, weapons, upgrades, techs, P1, P2, CurrentPlayer, AllPlayers, type Location, type Unit } from "trigscript";

// The map's names are not known to this script: a location is its number (build-fixture makes 1 and 2).
const HOME = 1 as Location;
const AWAY = 2 as Location;

trigger(P1, [always()], [displayText("trigger(): hello — the slice 3 probe")]);

program(() => {
  sleep(seconds(2));
  createUnit(P1, units.TerranMarine, 3, HOME);
  let n = 0;
  let sum = 0;
  for (const u of unitsAt(HOME, { owner: P1 })) { n++; sum += u.hp; }
  displayText(`A: ${n} of your units at Home (expect 3), their hit points added up ${sum} (expect 120)`);

  sleep(seconds(3));
  for (const u of unitsAt(HOME, { owner: P1, type: units.TerranMarine })) u.hp = u.maxHp / 2;
  displayText("B: select the three Marines at Home: 20 / 40 each");

  sleep(seconds(3));
  const runner = nearest(units.TerranMarine, AWAY, { owner: P1 });
  let startX = 0;
  if (runner) { startX = runner.x; runner.order("move", AWAY); displayText(`C: ONE Marine walks to Away, from x ${startX}; nobody else moves`); }
  else displayText("C: FAILED — nearest() found no Marine");

  sleep(seconds(5));
  if (runner) displayText(`D: the runner is at x ${runner.x} now (it was ${startX}), type ${runner.type} (expect 0), owner ${runner.owner} (expect 0)`);
  else displayText("D: FAILED — the runner was lost across the sleep");

  sleep(seconds(2));
  if (runner) runner.kill();
  sleep(frames(48));
  let there = 0;
  if (runner) there = 1;
  displayText(`E: the runner died. if (runner) is ${there} (expect 0); its hit points read ${runner ? runner.hp : 0} (expect 0)`);

  sleep(seconds(1));
  const hurt = first({ owner: P1, type: units.TerranMarine, at: HOME });
  if (hurt) {
    const before = hurt.hp;
    hurt.damage(15);
    const low = hurt.hp;
    hurt.heal({ percent: 50 });
    displayText(`F: a Marine at Home: ${before} → ${low} → ${hurt.hp} (expect 20 → 5 → 25)`);
  } else displayText("F: FAILED — no Marine at Home");

  sleep(seconds(3));
  for (const u of unitsAt(HOME, { owner: P1 })) u.invincible = true;
  createUnit(P2, units.ZergZergling, 4, HOME);
  displayText("G: four Zerglings attack; the Marines at Home are invincible and lose no hit points");

  sleep(seconds(8));
  let given = 0;
  for (const z of unitsOf(P2, { type: units.ZergZergling, at: HOME })) {
    if (given == 0) { z.give(P1); given = 1; continue; }
    z.remove();
  }
  for (const u of unitsAt(HOME, { owner: P1 })) u.invincible = false;
  displayText("H: ONE Zergling is yours now; the other three vanished with no death animation");

  sleep(seconds(3));
  let men = 0;
  let buildings = 0;
  let everything = 0;
  for (const u of unitsOf(P1, { type: units.Men })) men++;
  for (const u of unitsOf(P1, { type: units.Buildings })) buildings++;
  for (const u of allUnits({ owner: P1 })) everything++;
  displayText(`I: your Men ${men}, your Buildings ${buildings} (expect 1), all yours ${everything} (expect their sum)`);

  sleep(seconds(3));
  const r1 = randomUnit({ owner: P1, type: units.Men });
  const r2 = randomUnit({ owner: P1, type: units.Men });
  const r3 = randomUnit({ owner: P1, type: units.Men });
  displayText(`J: three draws among your Men, by x: ${r1 ? r1.x : 0}, ${r2 ? r2.x : 0}, ${r3 ? r3.x : 0} — not always one number`);

  sleep(seconds(3));
  function weakest(): Unit | null {
    let best: Unit | null = null;
    let least = 9999;
    for (const u of unitsOf(P1, { type: units.Men })) { if (u.hp < least) { least = u.hp; best = u; } }
    return best;
  }
  // F's Marine is at 25 and another at Home is still at 20 from B: ten more off F's makes it the weakest, at 15.
  if (hurt) hurt.damage(10);
  const weak = weakest();
  let same = 0;
  let other = 0;
  if (weak && weak == hurt) same = 1;
  if (weak && weak != first({ owner: P1, type: units.TerranCommandCenter })) other = 1;
  displayText(`K: the weakest of your Men has ${weak ? weak.hp : 0} hit points (expect 15); it is F's Marine: ${same} (expect 1); it is not the Command Center: ${other} (expect 1)`);

  sleep(seconds(3));
  const base = first({ owner: P1, type: units.TerranCommandCenter });
  if (base) { base.locate(AWAY); createUnit(P1, units.TerranFirebat, 1, AWAY); displayText("L: a Firebat appears at your Command Center, not beside Home"); }
  else displayText("L: FAILED — no Command Center found");

  sleep(seconds(3));
  createUnit(P1, units.TerranGhost, 1, HOME);
  const ghost = first({ owner: P1, type: units.TerranGhost });
  if (ghost) {
    ghost.energy = 250;
    ghost.kills = 7;
    ghost.lockdown = 100;
    displayText(`M: the Ghost at Home: energy ${ghost.energy} (expect 250), kills ${ghost.kills} (expect 7), locked down — order it to move: it cannot, for about half a minute`);
  } else displayText("M: FAILED — no Ghost found");

  sleep(seconds(3));
  stats(units.TerranMarine).minerals = 10;
  stats(weapons.GaussRifle).damage += 20;
  stats(P1).upgrades[upgrades.TerranInfantryWeapons] = 3;
  stats(P1).researched[techs.Lockdown] = true;
  stats(units.TerranMarine).detector = true;
  displayText(`N2: a flag read back: Marines are detectors ${stats(units.TerranMarine).detector ? 1 : 0} (expect 1), Firebats ${stats(units.TerranFirebat).detector ? 1 : 0} (expect 0)`);
  displayText(`N: stats() read back: Marine cost ${stats(units.TerranMarine).minerals} (expect 10), Gauss Rifle ${stats(weapons.GaussRifle).damage} (expect 26), weapons level ${stats(P1).upgrades[upgrades.TerranInfantryWeapons]} (expect 3; a Marine shows +3), Lockdown ${stats(P1).researched[techs.Lockdown] ? 1 : 0} (expect 1; the Ghost has the button)`);

  sleep(seconds(3));
  stats(P1).color = colors.green;
  stats(units.ZergZergling).name = "Dog";
  createUnit(P1, units.ZergZergling, 1, HOME);
  displayText("O: you are GREEN now, units and minimap; select a Zergling: it is called Dog");

  sleep(seconds(3));
  stats(units.TerranMarine).speed = 12;
  createUnit(P1, units.TerranMarine, 1, HOME);
  let fresh: Unit | null = null;
  for (const u of unitsAt(HOME, { owner: P1, type: units.TerranMarine })) { if (u.hp == u.maxHp) fresh = u; }
  if (fresh) { fresh.order("move", AWAY); displayText("P: the new Marine RUNS to where Away is now (your Command Center), far faster than a Marine walks"); }
  else displayText("P: FAILED — the new Marine was not found by its full hit points");
});

// Every player at once, each with a unit of their own kept across the frames.
program(() => {
  let mine: Unit | null = null;
  let told = false;
  sleep(seconds(58));
  while (true) {
    if (!mine) mine = first({ owner: CurrentPlayer, type: units.Buildings });
    if (mine && !told) { told = true; displayText(`Q: per player — the building this player keeps has ${mine.hp} hit points (yours: a Command Center, 1500)`); }
    sleep(seconds(1));
  }
}, { owner: AllPlayers });
