// ledger: step 8, takes
// Frames of game time as minutes and seconds, from `trigscript/ui`: `clock(frames)` ("1:05").
import { clock } from "trigscript/ui";
program(() => {
  let frames = 0;
  while (frames < 1500) frames += 24;
  print(`Time ${clock(frames)}`);
});
