// ledger: step 4, takes
// The place of one of some weights, each as likely as its share, from `trigscript/random`: `weighted([70, 25, 5])`.
import { weighted } from "trigscript/random";
program(() => {
  const tier = weighted([70, 25, 5]);
  if (tier === 0) print("common");
  else print("rare");
});
