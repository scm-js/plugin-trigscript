// ledger: step 11, refused: a task started
// trigscript/timers: an `every` stopped by the task it gives back: `const t = every(…); t.cancel()`.
import { every, SECOND } from "trigscript/timers";
program(async () => {
  const t = every(SECOND, (n) => {
    print(`${n}`);
  });
  await sleep(frames(5 * SECOND));
  t.cancel();
});
