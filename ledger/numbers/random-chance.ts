// ledger: step 4, takes
// True a number of times in a hundred, from `trigscript/random`: `chance(25)`.
import { chance } from "trigscript/random";
program(() => {
  if (chance(25)) print("lucky");
  else print("not this time");
});
