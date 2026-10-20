// ledger: step 6, refused: a read of memory.game.frame
// trigscript/timers: `now()`, the frames of game time since the game began.
import { now } from "trigscript/timers";
program(() => {
  print(`${now()}`);
});
