// ledger: step 6, refused: a read of memory.game.frame
// trigscript/timers: a `Countdown`, a length of time that runs down while the game runs: `left()` and `done()`.
import { Countdown } from "trigscript/timers";
program(async () => {
  const round = new Countdown(48);
  while (!round.done()) {
    print(`${round.left()}`);
    await sleep(frames(12));
  }
  print("time");
});
