// ledger: step 0, takes
// trigscript/timers: `SECOND`, the frames of a second of game time (24), for a wait counted in frames.
import { SECOND } from "trigscript/timers";
program(async () => {
  await sleep(frames(2 * SECOND));
  print("two seconds");
});
