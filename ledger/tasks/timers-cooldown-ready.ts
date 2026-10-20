// ledger: step 6, takes
// trigscript/timers: a `Cooldown` asked whether it is ready, how long until it is, and made ready again: `ready()`, `left()`, `reset()`.
import { Cooldown } from "trigscript/timers";
program(async () => {
  const blink = new Cooldown(24);
  blink.use();
  await sleep(frames(5));
  if (!blink.ready()) print(`${blink.left()}`);
  blink.reset();
  if (blink.ready()) print("ready");
});
