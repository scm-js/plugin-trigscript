// ledger: step 0, takes
// A number moved towards another by a step at most, never past it, from `trigscript/math`: `approach(x, target, step)`.
import { approach } from "trigscript/math";
program(() => {
  let x = 0;
  let n = 0;
  while (n < 5) {
    x = approach(x, 12, 5);
    n += 1;
  }
  print(`${x}`);
});
