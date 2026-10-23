// TrigScript 4, the backend: the map's own triggers in a map of our own (scripts/build-own.mts) — step 13 of the way off
// eudplib. The script's trigger() and hyperTriggers() records are laid out as the game's own nodes in the payload, a
// copy for each player whose list the game would copy them into, chained after the player's entry and before their
// gate: each player's run in turn before the programs, as eudplib's build runs a map's triggers (RunTrigTrigger) before
// its programs. A trigger that is not preserved is switched off once it has run, a Wait holds it in the player's wait
// slot, a disabled trigger, condition or action is passed over — all the game's own doing.
// Built both ways (through eudplib, and as a map of our own), the lifted game should print the same lines at the same
// frames; every line should end "ok", and a line ending "WRONG" names the check that failed.
//   npx tsx scripts/build-own.mts probes/own-triggers.ts /tmp/own-triggers.scx
//   npx tsx scripts/build-fixture.mts probes/own-triggers.ts /tmp/own-triggers-eud.scx
import { program, print, sleep, frames, trigger, hyperTriggers, always, never, disabled, deaths, setDeaths, displayText, wait, elapsedTime, preserve, units, P1, P2, P5, AllPlayers, CurrentPlayer } from "trigscript";

// A: preserved, Player 1's: one more each frame, before the program's turn.
trigger(P1, [always()], [setDeaths(P1, units.TerranMarine, "add", 1), preserve()]);
// B: not preserved: runs once, then is switched off.
trigger(P1, [always()], [setDeaths(P1, units.TerranFirebat, "add", 1)]);
// C: All Players: a copy in each player's list, each counting for the current player once A has counted to 3.
trigger(AllPlayers, [deaths(P1, units.TerranMarine, ">=", 3)], [setDeaths(CurrentPlayer, units.TerranGhost, "add", 1), preserve()]);
// D: a Wait of half a second, then a line: the game holds the trigger in Player 1's wait slot.
trigger(P1, [always()], [wait(500), displayText("D: waited half a second")]);
// E: a disabled trigger never runs; a disabled condition is passed over; a disabled action is skipped.
trigger(P1, [always()], [setDeaths(P1, units.TerranGoliath, "set", 99)], { disabled: true });
trigger(P1, [always(), disabled(never())], [setDeaths(P1, units.TerranVulture, "set", 7), disabled(setDeaths(P1, units.TerranVulture, "set", 8))]);
// F: a trigger for a player not in the game never runs.
trigger(P5, [always()], [setDeaths(P1, units.TerranWraith, "set", 1), preserve()]);
// G: the game's own line, a second in.
trigger(P1, [elapsedTime(">=", 1)], [displayText("G: a second in")]);
// H: hyper triggers for the computer: nothing of the above should change.
hyperTriggers(P2);

program(async () => {
  print("Own triggers: the payload runs.");
  // The program's first turn comes after every player's triggers of the frame: A and B have each run once.
  const a1 = deaths(P1, units.TerranMarine), b1 = deaths(P1, units.TerranFirebat);
  if (a1 == 1 && b1 == 1) print("A: the triggers run before the program ok"); else print(`A: WRONG ${a1} ${b1}`);
  await sleep(frames(3));
  // Three frames on: A has counted 4, B is switched off at 1; C ran for both players when A read 3 and 4.
  const a4 = deaths(P1, units.TerranMarine), b4 = deaths(P1, units.TerranFirebat), c1 = deaths(P1, units.TerranGhost), c2 = deaths(P2, units.TerranGhost);
  if (a4 == 4 && b4 == 1) print("B: a trigger not preserved ran once ok"); else print(`B: WRONG ${a4} ${b4}`);
  if (c1 == 2 && c2 == 2) print("C: All Players, a copy a player ok"); else print(`C: WRONG ${c1} ${c2}`);
  const e1 = deaths(P1, units.TerranGoliath), e2 = deaths(P1, units.TerranVulture), f = deaths(P1, units.TerranWraith);
  if (e1 == 0 && e2 == 7) print("E: disabled trigger, condition and action ok"); else print(`E: WRONG ${e1} ${e2}`);
  if (f == 0) print("F: a player not in the game ok"); else print(`F: WRONG ${f}`);
  await sleep(frames(40));
  const a44 = deaths(P1, units.TerranMarine);
  if (a44 == 44) print("A2: counted every frame ok"); else print(`A2: WRONG ${a44}`);
  print("Weighed");
});
