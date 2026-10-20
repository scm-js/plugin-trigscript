// ledger: step 4, takes
// Degrees as radians, from `trigscript/math`: `radians(d)`.
import { radians } from "trigscript/math";
program(() => {
  let d = 0;
  while (d < 90) d += 25;
  const r = radians(d);
  if (r > 1.6) print("more than 1.6");
  else print("1.6 or less");
});
