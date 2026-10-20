// ledger: step 6, refused: a read of memory.game.frame
// trigscript/timers: a `Stopwatch`, the frames since it was made or reset: `elapsed()`, `reset()`.
import { Stopwatch } from "trigscript/timers";
program(async () => {
  const lap = new Stopwatch();
  await sleep(frames(10));
  print(`${lap.elapsed()}`);
  lap.reset();
});
