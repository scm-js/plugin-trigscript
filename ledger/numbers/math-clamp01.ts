// ledger: step 0, takes
// A fraction kept between 0 and 1, from `trigscript/math`: `clamp01(t)`.
import { clamp01 } from "trigscript/math";
program(() => {
  let t = 0;
  while (t < 1.2) t += 0.5;
  if (clamp01(t) === 1) print("one");
  else print("below one");
});
