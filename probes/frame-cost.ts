// TrigScript 4, A4's probe: the dial. How much trigger work a frame Remastered takes before the game stutters.
// You are Player 1 with whatever the base map gives you; nothing here needs a second player. Play it alone, at
// Fastest, and keep something moving (a unit walking back and forth, or scroll the screen) so a stutter shows.
//
// The map climbs a ladder by itself: every STEP seconds of game time it does more work every frame, and says so:
//   "step 4: about 10 thousand conditions and actions a frame"
// The count is the lifted game's: each step's loop was measured there (scripts/game-check.mts prints it), at about
// 39 conditions and actions a turn of the loop. Elapsed time in the game slows when the frames do, so a step that
// lags also lasts longer on the wall clock.
//
//   W  one step up        Q  one step down        E  stop climbing / climb again
//
// WHAT TO NOTE: the first step at which the game stutters (units jerk, the screen hitches), the first at which it
// is plainly slow (a game second clearly longer than a real one), and, if it gets there, the step at which it
// freezes or drops. Say which Remastered (patch number) and the computer it ran on.
//
// Built with `npx tsx scripts/build-fixture.mts probes/frame-cost.ts fixtures/eud/frame-cost.scx`.
import { program, displayText, sleep, seconds, frames, keyPressed, P1 } from "trigscript";

const STEP = 10;

program(() => {
  // Turns of the loop for each step, and what that comes to a frame in thousands (39 a turn, measured).
  const turns = [0, 26, 51, 128, 256, 513, 1282, 2564, 5128, 12820, 25641];
  const thousands = [0, 1, 2, 5, 10, 20, 50, 100, 200, 500, 1000];
  let step = 0;
  let climbing = true;
  let next = 0;
  let x = 0;
  let shown = -1;
  let frame = 0;
  while (true) {
    frame += 1;
    if (keyPressed(P1, "W") && step < 10) { step += 1; next = frame + STEP * 24; }
    if (keyPressed(P1, "Q") && step > 0) { step -= 1; next = frame + STEP * 24; }
    if (keyPressed(P1, "E")) { climbing = !climbing; displayText(climbing ? "climbing again" : "holding at this step"); next = frame + STEP * 24; }
    if (climbing && frame >= next && step < 10) { if (next > 0) step += 1; next = frame + STEP * 24; }
    if (step != shown) {
      shown = step;
      if (step == 0) displayText("step 0: nothing a frame — W up, Q down, E holds");
      else displayText(`step ${step}: about ${thousands[step]} thousand conditions and actions a frame`);
    }
    const n = turns[step];
    for (let i = 0; i < n; i++) { x += 1; }
    sleep(frames(1));
  }
}, { owner: P1 });
