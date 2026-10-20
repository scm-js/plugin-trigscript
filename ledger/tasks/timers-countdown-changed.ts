// ledger: step 6, takes
// trigscript/timers: a `Countdown` given more time, and started again: `add(frames)`, `restart(length)`.
import { Countdown } from "trigscript/timers";
program(async () => {
  const fuse = new Countdown(24);
  fuse.add(12);
  await sleep(frames(30));
  if (!fuse.done()) fuse.restart(24);
  print(`${fuse.left()}`);
});
