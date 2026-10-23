// The UI spike's second round (TrigScript 4, S2): the colours of a board in the text lines. The script below does
// next to nothing; what is tried is probes/ui-spike-2.py, hand-written eudplib built into the same map. Single
// player is fine. The leaderboard shows a clock. What to look for, by the second (each step says so on the screen):
//   A1   2  one colour code per line, then red, green and blue cells and "end": which lines stay one colour?
//   A2  14  the rest of the codes
//   B1  26  a board, empty cells in 15 (brown), drawn as one Display Text a frame: piece orange? stack coloured?
//   B2  38  empty cells in 18 (dark green)
//   B3  50  empty cells in 1E (lavender)
//   B4  62  empty cells in 0E (blue)
//   C   74  one line printed once: at which clock does it go?
// Built with
//   EXTRA_PLUGIN=uiSpike2=probes/ui-spike-2.py npx tsx scripts/build-fixture.mts probes/ui-spike-2.ts fixtures/eud/ui-spike-2.scx
import { program, displayText, P1 } from "trigscript";

program(() => {
  sleep(seconds(1));
  displayText("The UI spike, second round: steps A to C, about a minute and a half.");
}, { owner: P1 });
