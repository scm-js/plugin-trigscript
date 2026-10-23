// TrigScript 4, the backend: the game's actions with fields from values in a map of our own (scripts/build-fixture.mts) —
// step 5 of the way off eudplib, part 2. A field from a value is a place of its variable, kept by the variable's
// writes, so the action reads it where it is; a unit count is the action done 255 at a time while more are left, then
// once with the rest, 0 or below doing nothing. Built both ways (through eudplib, and as a map of our own), the lifted
// game should print the same lines at the same frames; every line should end "ok", and a line ending "WRONG" names
// the check that failed; line I is a Transmission's own text. Frame 2 (the lifted game's 4) is 200 actions with an amount from a value, to weigh.
//   npx tsx scripts/build-fixture.mts probes/own-fields.ts /tmp/own-fields.scx
//   npx tsx scripts/build-fixture.mts probes/own-fields.ts /tmp/own-fields-eud.scx
// The map build-own makes: Player 1 a person with a Command Center and 4 Marines, Player 2 a computer with a Hatchery
// and 4 Zerglings.
import { program, print, sleep, frames } from "trigscript";

program(() => {
  // A: an amount from a value, and one from a sum.
  let n = 4;
  n += 1;
  setDeaths(P1, units.TerranMarine, "set", n);
  let bounty = 50;
  bounty += 25;
  setResources(P1, "set", bounty + 25, "ore");
  if (deaths(P1, units.TerranMarine, "==", 5) && accumulate(P1, "==", 100, "ore")) print("A: amounts ok"); else print("A: amounts WRONG");
  // B: a unit type from a value: the deaths of the type it holds, made and counted.
  let kind: UnitType = units.TerranMarine;
  if (n > 2) kind = units.TerranFirebat;
  setDeaths(P1, kind, "add", 7);
  createUnit(P1, kind, 2, locations.Anywhere);
  if (deaths(P1, units.TerranFirebat, "==", 7) && deaths(P1, units.TerranMarine, "==", 5) && command(P1, units.TerranFirebat, "==", 2)) print("B: a unit type ok");
  else print("B: a unit type WRONG");
  // C: a unit count from a value — 3, 0, below zero — of Wraiths (air units: they stack where ground units would not
  // all fit).
  let count = 3;
  createUnit(P1, units.TerranWraith, count, locations.Anywhere);
  count = 0;
  createUnit(P1, units.TerranWraith, count, locations.Anywhere);
  count = -2;
  createUnit(P1, units.TerranWraith, count, locations.Anywhere);
  if (command(P1, units.TerranWraith, "==", 3)) print("C: a unit count ok"); else print("C: a unit count WRONG");
  // D: the type and the count both from values; a kill of the type a value holds (counted a frame later: the game
  // counts a unit killed or removed until the next frame).
  let many = 2;
  many += 1;
  kind = units.TerranValkyrie;
  createUnit(P1, kind, many, locations.Anywhere);
  let three = false;
  if (command(P1, units.TerranValkyrie, "==", 3)) three = true;
  killUnit(P1, kind);
  // F: the countdown from a value.
  let seconds = 60;
  seconds += 30;
  setCountdownTimer("set", seconds);
  if (countdownTimer("==", 90)) print("F: the countdown ok"); else print("F: the countdown WRONG");
  sleep(frames(2));
  // Frame 2: 200 actions, each adding a value that changes every turn.
  let j = 0;
  setDeaths(P1, units.TerranMarine, "set", 0);
  while (j < 200) {
    setDeaths(P1, units.TerranMarine, "add", j);
    j++;
  }
  if (deaths(P1, units.TerranMarine, "==", 19900)) print("G: 200 amounts from a value ok"); else print("G: 200 amounts from a value WRONG");
  if (three && command(P1, units.TerranValkyrie, "==", 0)) print("D: a type and a count ok"); else print("D: a type and a count WRONG");
  // H (frames 4 and 6, the lifted game's 6 and 8): a count past what a byte holds — 258 Scourges for Player 2 (air
  // units), then 258 removed. The game places about 253 at one point before it says "Unit unplaceable", up to eleven
  // times, which fills the screen: the lines come two frames later. A count cut to a byte would be 2 either way.
  sleep(frames(2));
  count = 258;
  createUnit(P2, units.ZergScourge, count, locations.Anywhere);
  let made = false, removed = false;
  if (command(P2, units.ZergScourge, ">=", 250)) made = true;
  removeUnitAt(P2, units.ZergScourge, count, locations.Anywhere);
  sleep(frames(2));
  if (command(P2, units.ZergScourge, "==", 0)) removed = true;
  if (made) print("H: 258 made ok"); else print("H: 258 made WRONG");
  if (removed) print("H: 258 removed ok"); else print("H: 258 removed WRONG");
  // I: a Transmission whose text is made while the game runs (it shows among the text lines), and the program going on
  // after it (a Transmission waits as Wait does).
  let left = 4;
  left -= 1;
  transmission(`I: ${left} bunkers left ok`, units.TerranMarine, locations.Anywhere, "add", 0, "sound\\glue\\mousedown2.wav", 500);
  setMissionObjectives(`Survive wave ${left}`);
  print("Own fields: done.");
});
