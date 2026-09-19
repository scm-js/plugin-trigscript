// The strings spike (slice 8½), played before any compiler work. The script below does next to nothing:
// what is being tried is probes/strings-spike.py, hand-written eudplib built into the same map, which
// writes a text made in the game over a reserved string of the table and then runs the action that
// names it. What to look for, by the second (each step says so on the screen too):
//   A   3  a line of text made through a slot — the control; if this is wrong, the write itself is.
//   B   6  open the objectives: "B: objectives made at second 6 / Collect 6/10 relics".
//   C  21  open them again: still B = the game copied the text when the action ran; C = it reads it each time.
//   D  36  a leaderboard whose label says "D: kills, made at 36".
//   E  46  the label: still D = copied; E = read each time it is drawn.
//   F  56  for ten seconds the slot is written every second: does the label count?
//   G  70  a transmission from the Command Center: "G: a transmission made at second 70".
//   H  74  did its line change to H while it was up?
//   I  84  Korean, and an emoji between two bars: what is drawn of each?
//   J  97  (last, since a refused write ends the game) select a Marine: "J: Marine of second 97"?
//   K 107  deselect, select again: "K: renamed at 107"?
// Built with
//   EXTRA_PLUGIN=stringsSpike=probes/strings-spike.py npx tsx scripts/build-fixture.mts probes/strings-spike.ts fixtures/eud/strings-spike.scx
import { program, displayText, P1 } from "trigscript";

program(() => {
  sleep(seconds(1));
  displayText("The strings spike: steps A to K, about two minutes. Each says what to look for.");
}, { owner: P1 });
