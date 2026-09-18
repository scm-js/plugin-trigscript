// TrigScript 3.2's probe (slice 2): reads, player facts, text with values in it, random(n), the bitwise operators.
// Play it alone (Use Map Settings): you are Player 1, Terran, with a Command Center and four Marines;
// Player 2 is a computer, Zerg, in the other force. Every line says what it expects, so a wrong number shows.
//
//   0 s  "trigger(): hello"
//   2 s  A  minerals() — reads 123, and your gas becomes a copy of it (look at the top bar: 123 / 123)
//   5 s  B  deaths() — reads 7 for Player 1 and for CurrentPlayer
//   8 s  C  countUnits() — 4 Marines, 5 units anywhere (the Command Center too), 4 Zerglings (the computer's, at its base, out of sight)
//  11 s  D  a force's ore and gas added up — 150 — and the score, which is not 0
//  14 s  E  the clocks — elapsed() about 21 (game seconds are sixteen frames: the first play taught that), countdown() 90 or 89 (a timer appears at the top)
//  17 s  F  race 1 and 0, slot 2 and 1 and 0 (the second play read 5 for the computer: a Use Map Settings computer's own number, now given as 1), then F2: five facts as 1 / 0 — "1 1 1 1 1" — and the bytes the first probe read for "left"
//  20 s  G  supply — used 4, max 200, provided 10 (it only reads: nothing in the top bar changes)
//  23 s  H  your name in your colour, then the computer's
//  26 s  I  a line in the MIDDLE of the screen, where "Not enough minerals" appears — is there a sound with it?
//  29 s  J  a line the computer's program sent to you
//  32 s  K  six rolls of random(6), each 0 … 5 — play twice: the rolls should differ between games
//  35 s  L  the bitwise operators: 8 14 6 32 25
//  38 s  M  four Zerglings appear next to your base: kill them, the count is printed each time it changes
//
// Built with `npx tsx scripts/build-fixture.mts probes/reads.ts fixtures/eud/reads.scx`.
import { trigger, program, always, displayText, print, createUnit, setResources, setDeaths, setCountdownTimer, sleep, seconds, frames, random, minerals, gas, deaths, countUnits, resources, score, kills, elapsed, countdown, race, slot, isHuman, hasLeft, supply, name, color, races, slots, units, locations, players, P1, P2, P3, CurrentPlayer, type Location, type Player } from "trigscript";

// Location 1 is "Home", which build-fixture puts next to Player 1's base; the map's names are not known to this script.
const HOME = 1 as Location;
// A memory address as the player of deaths(): the deaths table starts at 0x58A364, four bytes a player.
const LEFT_TABLE = ((0x581d60 - 0x58a364) / 4) as Player;

trigger(P1, [always()], [displayText("trigger(): hello")]);

program(() => {
  sleep(seconds(2));
  setResources(P1, "set", 123, "ore");
  setResources(P1, "set", minerals(P1), "gas");
  displayText(`A: minerals() reads ${minerals(P1)} (expect 123); gas() reads ${gas(P1)} (expect 123, a copy)`);

  sleep(seconds(3));
  setDeaths(P1, units.TerranMarine, "set", 7);
  let lost = deaths(CurrentPlayer, units.TerranMarine);
  displayText(`B: deaths() reads ${deaths(P1, units.TerranMarine)} and ${lost} for CurrentPlayer (expect 7 and 7)`);
  setDeaths(P1, units.TerranMarine, "set", 0);

  sleep(seconds(3));
  displayText(`C: ${countUnits(P1, units.TerranMarine)} Marines (expect 4), ${countUnits(P1, units.AnyUnit, locations.Anywhere)} units anywhere (expect 5), ${countUnits(P2, units.ZergZergling)} Zerglings (expect 4)`);

  sleep(seconds(3));
  setResources(P1, "set", 100, "ore");
  setResources(P1, "set", 50, "gas");
  displayText(`D: your force's ore and gas: ${resources(players.Force1, "oreAndGas")} (expect 150); your total score: ${score(P1, "total")} (not 0)`);

  sleep(seconds(3));
  setCountdownTimer("set", 90);
  displayText(`E: elapsed() reads ${elapsed()} (expect about 21, in game seconds); countdown() reads ${countdown()} (expect 90 or 89)`);

  sleep(seconds(3));
  displayText(`F: race ${race(P1)} and ${race(P2)} (expect 1 and 0); slot ${slot(P1)}, ${slot(P2)}, ${slot(P3)} (expect 2, 1, 0)`);
  // Each fact on its own, so a wrong one shows: the first probe said only that one of them failed.
  displayText(`F2: isHuman(P1) ${isHuman(P1) ? 1 : 0}, !isHuman(P2) ${isHuman(P2) ? 0 : 1}, !hasLeft(P1) ${hasLeft(P1) ? 0 : 1}, !hasLeft(P2) ${hasLeft(P2) ? 0 : 1}, Terran ${race(CurrentPlayer) == races.Terran ? 1 : 0} (expect 1 1 1 1 1)`);
  if (isHuman(P1) && !isHuman(P2) && !hasLeft(P1) && race(CurrentPlayer) == races.Terran && slot(P2) == slots.Computer) displayText("F3: and all of them together hold");
  else displayText("F3: FAILED - together they do not hold, though each may above");
  // For the record: the four bytes from 0x581D60, where the first probe looked for "left" (its bytes 2 and 3 were P1 and P2).
  displayText(`F4: the old table reads ${deaths(LEFT_TABLE, 0)} (any number; tell me which)`);

  sleep(seconds(3));
  displayText(`G: supply used ${supply(P1)} (expect 4), max ${supply(P1, "max")} (expect 200), provided ${supply(P1, "provided")} (expect 10); Zerg supply of the computer ${supply(P2, "used", races.Zerg)} (expect 2 or more)`);

  sleep(seconds(3));
  displayText(`H: you are ${color(P1)}${name(P1)}\x01 and the computer is ${color(P2)}${name(P2)}\x01 (each name in its colour)`);

  sleep(seconds(3));
  let wave = 3;
  print(`I: this line is in the middle of the screen - wave ${wave}`, { position: "center" });

  sleep(seconds(6));
  let a = random(6); let b = random(6); let c = random(6); let d = random(6); let e = random(6); let f = random(6);
  displayText(`K: six rolls of random(6): ${a} ${b} ${c} ${d} ${e} ${f} (each 0 to 5; different in the next game)`);

  sleep(seconds(3));
  let x = 12; let y = 10; let one = 1; let five = 5; let big = 200; let three = 3;
  displayText(`L: ${x & y} ${x | y} ${x ^ y} ${one << five} ${big >> three} (expect 8 14 6 32 25)`);

  sleep(seconds(3));
  displayText("M: four Zerglings next to your base - kill them, the count follows");
  createUnit(P2, units.ZergZergling, 4, HOME);
  let seen = 0;
  while (true) {
    if (kills(P1, units.ZergZergling) != seen) {
      seen = kills(P1, units.ZergZergling);
      displayText(`M: ${name(CurrentPlayer)} has killed ${seen}; ${countUnits(P2, units.ZergZergling)} left`);
    }
    sleep(frames(4));
  }
}, { owner: P1 });

program(() => {
  sleep(seconds(29));
  setResources(CurrentPlayer, "set", 777, "ore");
  print(`J: from the computer's program, which has ${minerals(CurrentPlayer)} ore (expect 777)`, { to: P1 });
}, { owner: players.Force2 });
