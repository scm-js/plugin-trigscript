// ledger: step 11, refused: a task started
// trigscript/timers: `after(delay, fn)`, a function run once, so many frames from now, in a task beside the program.
import { after, SECOND } from "trigscript/timers";
program(async () => {
  after(3 * SECOND, () => {
    print("Go!");
  });
});
