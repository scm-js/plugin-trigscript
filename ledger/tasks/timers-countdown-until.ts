// ledger: step 6, refused: a read of memory.game.frame
// trigscript/timers: a wait until a `Countdown` has run out: `await until(() => round.done())`.
import { Countdown, SECOND } from "trigscript/timers";
program(async () => {
  const round = new Countdown(3 * SECOND);
  await until(() => round.done());
  print("time");
});
