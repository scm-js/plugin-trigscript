// ledger: step 4, takes
// A number brought round into 0 … size − 1, below zero too, from `trigscript/math`: `wrap(n, size)` (−1 is size − 1).
import { wrap } from "trigscript/math";
program(() => {
  let n = 0;
  while (n > -10) n -= 3;
  print(`${wrap(n, 10)}`);
});
