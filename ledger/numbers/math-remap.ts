// ledger: step 4, takes
// A number moved from one range into another, from `trigscript/math`: `remap(v, a1, b1, a2, b2)`.
import { remap } from "trigscript/math";
program(() => {
  let low = 0;
  let high = 10;
  let v = 0;
  while (v < 4) {
    low += 1;
    high += 2;
    v += 1.5;
  }
  const x = remap(v, low, high, 100, 200);
  if (x > 140) print("past 140");
  else print("not past 140");
});
