// ledger: step 4, refused: a product of two values
// From one number to another by a fraction, from `trigscript/math`: `lerp(a, b, t)`.
import { lerp } from "trigscript/math";
program(() => {
  let a = 0;
  let b = 10;
  let t = 0;
  while (t < 0.5) {
    a += 1;
    b += 3;
    t += 0.125;
  }
  const x = lerp(a, b, t);
  if (x > 14) print("past 14");
  else print("not past 14");
});
