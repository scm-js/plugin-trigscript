// ledger: step 4, refused: a random number
// The total of dice thrown, from `trigscript/random`: `dice(3, 6)`, from 3 to 18.
import { dice } from "trigscript/random";
program(() => {
  const total = dice(3, 6);
  if (total > 10) print("high");
  else print("low");
});
