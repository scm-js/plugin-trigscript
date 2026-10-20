// ledger: step 0, takes
// π from `trigscript/math`: `PI`, a number with a fraction known when the map is built.
import { PI } from "trigscript/math";
program(() => {
  let a = 0;
  let steps = 0;
  while (a < PI) {
    a += 0.5;
    steps += 1;
  }
  print(`${steps}`);
});
