// ledger: step 0, takes
// trigscript/cutscene: `SECOND`, the frames of a second of game time (24), for a scene's lengths.
import { SECOND } from "trigscript/cutscene";
program(async () => {
  await sleep(frames(3 * SECOND));
  print("three seconds");
});
