// ledger: step 0, takes
// A whole turn from `trigscript/math`: `TAU`, 2π, to keep an angle within one turn.
import { TAU } from "trigscript/math";
program(() => {
  let a = 0;
  let n = 0;
  while (n < 10) {
    a += 1.5;
    if (a >= TAU) a -= TAU;
    n += 1;
  }
  if (a < 3) print("first half");
  else print("second half");
});
