// The lowering bench (TrigScript 4, cheaper lowering): one kind of statement a line, each run R times a frame, weighed
// by line in the lifted game (`npx tsx scripts/bench-lowering.mts`, which builds this file and divides by R). Every
// value comes from the game (deaths of Player 8, which nothing changes), so nothing folds when the script is built.
// The bench's own loop (line LOOP) is the dial's: `for (let i = 0; i < n; i++)`. Its jump back is eudplib's, which the
// count puts under the line before it: TAIL, a store of a constant, takes it, so that the lines above it are their own.
import { program, sleep, frames, deaths, unitsOf, units, fixed, P1, P8 } from "trigscript";

const R = 100;
class Spot { x = 0; y = 0; }
function twice(v: number): number { return v * 2; }

program(() => {
  // Values the build cannot know: deaths nobody changes are 0 in the game.
  const zero = deaths(P8, units.TerranMarine);
  let n = zero + R;
  let x = zero, y = zero + 3, z = zero + 4, b = zero, k = zero;
  const spot = new Spot();
  let cells: number[] = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
  // Fixed numbers from the game too: 1.5 and -2.25, and one to put results in.
  let fa: fixed = fixed(zero) + 1.5, fb: fixed = fixed(zero) - 2.25, fr: fixed = 0.5;
  while (true) {
    for (let i = 0; i < n; i++) { /* LOOP */
      x += 1; /* ADD_CONST */
      x = y + z; /* ADD_VARS */
      if (y < z) b = 1; /* LESS_VARS */
      if (y < 5) b = 2; /* LESS_CONST */
      if (y == z) b = 3; /* EQUALS_VARS */
      x = cells[k]; /* ARRAY_READ */
      cells[k] = y; /* ARRAY_WRITE */
      x = cells[3]; /* ARRAY_READ_CONST */
      cells[5] = y; /* ARRAY_WRITE_CONST */
      spot.x = y; /* FIELD_WRITE */
      x = spot.x; /* FIELD_READ */
      x = twice(y); /* CALL */
      x = y * z; /* MULTIPLY */
      k = (k + 1) & 15; /* MASK */
      x = y * 12; /* MUL_CONST */
      x = y * 32; /* MUL_POW2 */
      x = y << 5; /* SHIFT_LEFT */
      x = z >> 2; /* SHIFT_RIGHT */
      x = z / 3; /* DIV_CONST */
      x = z % 3; /* MOD_CONST */
      fr = fa * fb; /* FIXED_MUL */
      fr = fa / fb; /* FIXED_DIV */
      fr = fa * 3; /* FIXED_MUL_INT */
      fr = Math.sqrt(fa); /* FIXED_SQRT */
      if (fa < fb) b = 4; /* FIXED_LESS */
      if (fa < 0) b = 5; /* FIXED_SIGN */
      x = Math.floor(fa); /* FIXED_FLOOR */
      b = 0; /* TAIL */
    }
    for (const u of unitsOf(P1)) { x += u.hp; } /* UNITS */
    sleep(frames(1));
  }
});
