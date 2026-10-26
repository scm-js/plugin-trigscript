// TrigScript 4, the backend: the game's own conditions and actions in a map of our own (scripts/build-fixture.mts) — step
// 5 of the way off eudplib, part 1. A condition or an action the script writes with every field known when the map is
// built is laid out as the game's record, as it is; a condition turned around with `!` is one condition where one
// says the opposite (at least n against at most n − 1, set against cleared), else a trigger that skips past. Built both
// ways (through eudplib, and as a map of our own), the lifted game should print the same lines at the same frames;
// every line should end "ok", and a line ending "WRONG" names the check that failed. Frames 2 and 4 (the lifted game's
// 4 and 6) are each one kind of work, 200 times, to weigh.
//   npx tsx scripts/build-fixture.mts probes/own-game.ts /tmp/own-game.scx
//   npx tsx scripts/build-fixture.mts probes/own-game.ts /tmp/own-game-eud.scx
// The map build-own makes: Player 1 a person with a Command Center and 4 Marines, Player 2 a computer with a Hatchery
// and 4 Zerglings.
import { program, print, sleep, frames } from "trigscript";

// A cell of the deaths table nobody else uses: Player 8's deaths of unit 227.
const CELL = 0x58a364 + 4 * (227 * 12 + 7);

program(() => {
  // A: a switch set and cleared, asked both ways.
  setSwitch(switches.Switch1, "set");
  const setA = switchIs(switches.Switch1, "set") && !switchIs(switches.Switch1, "cleared");
  setSwitch(switches.Switch1, "clear");
  if (setA && !switchIs(switches.Switch1, "set") && switchIs(switches.Switch1, "cleared")) print("A: switches ok"); else print("A: switches WRONG");
  // B: ore set, then asked at least, at most and exactly — each turned around too.
  setResources(P1, "set", 500, "ore");
  if (accumulate(P1, ">=", 500, "ore") && !accumulate(P1, ">=", 501, "ore") && accumulate(P1, "<=", 500, "ore")
    && !accumulate(P1, "<=", 499, "ore") && accumulate(P1, "==", 500, "ore") && !accumulate(P1, "==", 7, "ore")) print("B: ore ok");
  else print("B: ore WRONG");
  // C: deaths set and added to.
  setDeaths(P1, units.TerranMarine, "set", 3);
  const three = deaths(P1, units.TerranMarine, "==", 3) && !deaths(P1, units.TerranMarine, ">=", 4);
  setDeaths(P1, units.TerranMarine, "add", 2);
  if (three && deaths(P1, units.TerranMarine, "==", 5)) print("C: deaths ok"); else print("C: deaths WRONG");
  // D: units made, counted by Command and by Bring — asked before and after, which Bring would answer from what it
  // counted before unless a query of another kind is asked in between.
  let before = false;
  if (command(P1, units.TerranMarine, "==", 4) && bring(P1, units.TerranMarine, locations.Anywhere, "==", 4)) before = true;
  createUnit(P1, units.TerranMarine, 2, locations.Anywhere);
  if (before && command(P1, units.TerranMarine, "==", 6) && bring(P1, units.TerranMarine, locations.Anywhere, "==", 6)) print("D: units made ok");
  else print("D: units made WRONG");
  // E: the game's clock and the countdown.
  setCountdownTimer("set", 90);
  if (elapsedTime(">=", 0) && !elapsedTime(">=", 100000) && countdownTimer(">=", 90) && countdownTimer("<=", 90)) print("E: clocks ok");
  else print("E: clocks WRONG");
  // F: always, never, a score, the opponents.
  setScore(P1, "set", 10, "custom");
  if (always() && !never() && score(P1, "custom", "==", 10) && !score(P1, "custom", ">=", 11) && opponents(P1, "==", 1)) print("F: always, never, score, opponents ok");
  else print("F: always, never, score, opponents WRONG");
  // G: memory at an address known when the map is built.
  setMemory(CELL, "set", 77);
  setMemory(CELL, "add", 3);
  if (memory(CELL, "==", 80) && !memory(CELL, ">=", 81)) print("G: memory ok"); else print("G: memory WRONG");
  // H: an action's own text.
  displayText("H: display text ok");
  sleep(frames(2));
  // Frame 2: 200 turns, each asking three conditions and doing two actions.
  let j = 0, n = 0;
  setResources(P1, "set", 0, "ore");
  while (j < 200) {
    setResources(P1, "add", 1, "ore");
    if (accumulate(P1, ">=", 100, "ore") && !switchIs(switches.Switch1, "set") && deaths(P1, units.TerranMarine, "==", 5)) n++;
    setDeaths(P1, units.TerranMarine, "add", 0);
    j++;
  }
  if (n == 101) print("I: 200 turns of conditions and actions ok"); else print("I: 200 turns of conditions and actions WRONG");
  sleep(frames(2));
  // Frame 4: 200 turns of a condition turned around that no other one says (exactly).
  j = 0; n = 0;
  while (j < 200) {
    if (!deaths(P1, units.TerranMarine, "==", 5)) n++;
    setDeaths(P1, units.TerranMarine, "add", 1);
    j++;
  }
  if (n == 199) print("J: 200 turns of not exactly ok"); else print("J: 200 turns of not exactly WRONG");
  print("Own game: done.");
});
