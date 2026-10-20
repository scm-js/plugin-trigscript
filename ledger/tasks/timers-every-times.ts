// ledger: step 11, refused: a task started
// trigscript/timers: `every(period, fn, times)`, a function run so many times, so many frames apart.
import { every } from "trigscript/timers";
program(async () => {
  every(12, (n) => {
    print(`${n}`);
  }, 3);
});
