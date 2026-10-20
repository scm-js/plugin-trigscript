// ledger: step 4, takes
// An array of the program put in a random order, in place, from `trigscript/random`: `shuffle(order)`.
import { shuffle } from "trigscript/random";
program(() => {
  const order = [1, 2, 3, 4];
  shuffle(order);
  if (order[0] === 1) print("1 stayed first");
  else print("1 moved");
});
