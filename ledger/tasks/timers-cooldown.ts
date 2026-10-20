// ledger: step 6, refused: a read of memory.game.frame
// trigscript/timers: a `Cooldown`, something that can be done once every so many frames: `shot.use()` is true when it was ready.
import { Cooldown } from "trigscript/timers";
program(async () => {
  const shot = new Cooldown(12);
  let fired = 0;
  let i = 0;
  while (i < 48) {
    if (shot.use()) fired += 1;
    await nextFrame();
    i += 1;
  }
  print(`${fired}`);
});
