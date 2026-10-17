// The UI spike (TrigScript 4, S2), played before any compiler work: where a script can draw a screen of text the
// player watches while playing, for S2's Tetris. The script below does next to nothing; what is tried is
// probes/ui-spike.py, hand-written eudplib built into the same map. Host it as a multiplayer game, alone, so that
// opening the objectives does not pause it. What to look for, by the second (each step says so on the screen too):
//   A    2  thirteen numbered lines printed: which numbers stay on the screen?
//   B1  12  cell characters between bars: which rows end level with the ■ row?
//   B2  24  more cell characters; which are not drawn at all?
//   C   36  the colour codes on cells: which give a colour of their own?
//   D   48  rows of 10 to 60 cells: the longest on one line?
//   E   60  one Display Text with line breaks: six lines or one?
//   F1  70  a board in the text lines, redrawn every frame: flicker? tearing?
//   F2  82  the same, redrawn every fourth frame
//   F3  94  twenty rows in ten lines with half blocks
//   G  106  the lines' memory written every second with no action: do they count? when do lines fade?
//   H  126  open the objectives and keep them open: does the board fall while open? which rows show? clock paused?
//   I  161  the leaderboard's label as cells: where is it cut?
// Built with
//   EXTRA_PLUGIN=uiSpike=probes/ui-spike.py npx tsx scripts/build-fixture.mts probes/ui-spike.ts fixtures/eud/ui-spike.scx
import { program, displayText, P1 } from "trigscript";

program(() => {
  sleep(seconds(1));
  displayText("The UI spike: steps A to I, about three minutes. Each says what to look for.");
}, { owner: P1 });
