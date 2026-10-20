// ledger: step 4, takes
// Radians as degrees, from `trigscript/math`: `degrees(r)`.
import { degrees } from "trigscript/math";
program(() => {
  let r = 0;
  while (r < 1.5) r += 0.25;
  const d = degrees(r);
  if (d > 90) print("more than 90");
  else print("90 or less");
});
