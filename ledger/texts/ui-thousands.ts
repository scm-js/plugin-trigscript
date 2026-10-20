// ledger: step 8, refused: a function that gives back a text (thousands)
// A whole number with its thousands marked, from `trigscript/ui`: `thousands(n)` ("12,345").
import { thousands } from "trigscript/ui";
program(() => {
  let n = 0;
  while (n < 12000) n += 4115;
  print(`Ore ${thousands(n)}`);
});
