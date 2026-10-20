// ledger: step 4, takes
// One of a list at random, from `trigscript/random`: `pick(list)`.
import { pick } from "trigscript/random";
const WAVES = [5, 8, 13];
program(() => {
  const size = pick(WAVES);
  if (size > 6) print("a big wave");
  else print("a small wave");
});
