// ledger: step 0, takes
// A point of two numbers with a fraction, from `trigscript/math`: `new Vec(x, y)`, moved by another with `add`.
import { Vec } from "trigscript/math";
program(() => {
  let p = new Vec(fixed(0), fixed(0));
  const step = new Vec(fixed(1), 0.5);
  while (p.x < 5) p = p.add(step);
  if (p.y > 2) print("past 2");
  else print("not past 2");
});
