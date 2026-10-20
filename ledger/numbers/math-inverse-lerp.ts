// ledger: step 4, refused: a quotient of two values
// Where a number is between two others, as a fraction, from `trigscript/math`: `inverseLerp(a, b, v)`.
import { inverseLerp } from "trigscript/math";
program(() => {
  let a = 0;
  let b = 10;
  let v = 0;
  while (v < 14) {
    a += 1;
    b += 3;
    v += 3.5;
  }
  const t = inverseLerp(a, b, v);
  if (t > 0.4) print("past 0.4");
  else print("not past 0.4");
});
