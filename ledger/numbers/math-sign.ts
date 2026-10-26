// ledger: step 0, takes
// −1, 0 or 1 by whether a number is below, at or above zero, from `trigscript/math`: `sign(n)`.
import { sign } from "trigscript/math";
program(() => {
  let n = 5;
  while (n > -10) n -= 4;
  print(`${sign(n)}`);
});
