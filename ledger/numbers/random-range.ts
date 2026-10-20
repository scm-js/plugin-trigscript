// ledger: step 4, takes
// A random whole number from a low to a high, both included, from `trigscript/random`: `range(1, 3)`.
import { range } from "trigscript/random";
program(() => {
  const lane = range(1, 3);
  if (lane === 2) print("the middle lane");
  else print("a side lane");
});
