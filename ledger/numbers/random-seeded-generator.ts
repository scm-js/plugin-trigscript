// ledger: step 4, takes
// A random number generator of the script's own, seeded, the same numbers every game, from `trigscript/random`:
// `new Random(seed)`, then `rng.range(0, 63)`.
import { Random } from "trigscript/random";
program(() => {
  const rng = new Random(1234);
  const x = rng.range(0, 63);
  if (x < 32) print("left");
  else print("right");
});
