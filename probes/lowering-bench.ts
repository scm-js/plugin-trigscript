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
  const m = zero + 16;
  let x = zero, y = zero + 3, z = zero + 4, b = zero, k = zero;
  const spot = new Spot();
  const pts: Spot[] = [new Spot(), new Spot(), new Spot(), new Spot()];
  let j = zero + 2;
  let r: Spot = pts[1];
  const list: number[] = [];
  for (let i = 0; i < 16; i++) list.push(zero + i);
  let cells: number[] = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
  // Fixed numbers from the game too: 1.5 and -2.25, and one to put results in.
  let fa: fixed = fixed(zero) + 1.5, fb: fixed = fixed(zero) - 2.25, fr: fixed = 0.5;
  // Values whose range the compiler knows (compiler/ranges.ts) though not the value: 200 in 0 … 1023, 7 in 0 … 63.
  const sv = (zero + 200) & 1023, tv = (zero + 7) & 63;
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
      x = pts[j].x; /* ELEM_FIELD_READ */
      pts[j].y = y; /* ELEM_FIELD_WRITE */
      x = r.x; /* REF_FIELD_READ */
      r.y = y; /* REF_FIELD_WRITE */
      x = Math.min(78, Math.floor(78 / fa)); /* DIV_THRESHOLDS */
      x = Math.floor(78 / fa); /* DIV_FLOOR */
      x = Math.min(40, 1000 / y); /* DIV_VAR_THRESHOLDS */
      x = 1000 / y; /* DIV_VAR */
      x = list[k]; /* LIST_READ */
      list[k] = y; /* LIST_WRITE */
      x = sv * 12; /* MUL_CONST_R */
      x = sv * tv; /* MULTIPLY_R */
      x = sv / 3; /* DIV_CONST_R */
      x = sv % 10; /* MOD_CONST_R */
      x = 1000 / (tv + 1); /* DIV_VAR_R */
      x = sv / (tv + 1); /* DIV_VARS_R */
      x = sv >> 2; /* SHIFT_RIGHT_R */
      x = sv << 3; /* SHIFT_LEFT_R */
      if (sv < tv) b = 6; /* LESS_VARS_R */
      if (sv < 300) b = 7; /* LESS_CONST_R */
      b = 0; /* TAIL */
    }
    for (const u of unitsOf(P1)) { x += u.hp; } /* UNITS */
    for (const v of list) { x += v; } /* LIST_LOOP */
    for (let i = 0; i < m; i++) { x += cells[i]; } /* ARRAY_LOOP */
    for (let i = 0; i < m; i++) { cells[i] = y; } /* ARRAY_LOOP_WRITE */
    for (let i = 0; i < m; i++) { list[i] = y; } /* LIST_LOOP_WRITE */
    for (let i = 0; i < m; i++) { } /* EMPTY_LOOP */
    sleep(frames(1));
  }
});
