// ledger: step 4, refused: Math.sqrt
// How long a `Vec` from `trigscript/math` is: `v.length()`, the square root of its sides' squares.
import { Vec } from "trigscript/math";
program(() => {
  let v = new Vec(fixed(0), fixed(0));
  while (v.x < 3) v = v.add(new Vec(fixed(1), fixed(1)));
  if (v.length() > 4) print("longer than 4");
  else print("4 or shorter");
});
