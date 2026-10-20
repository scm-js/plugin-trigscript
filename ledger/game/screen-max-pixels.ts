// ledger: step 0, takes
// The screen library's most pixels a screen has, `MAX_PIXELS`: a number known when the map is built.
import { MAX_PIXELS } from "trigscript/screen";
program(() => {
  let rows = MAX_PIXELS >> 5;
  print(`${rows} rows of 32`);
});
