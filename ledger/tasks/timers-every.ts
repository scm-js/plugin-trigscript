// ledger: step 11, takes
// trigscript/timers: `every(period, fn)`, a function run every so many frames in a task beside the program, handed how many times it has run.
import { every, SECOND } from "trigscript/timers";
program(async () => {
  every(SECOND, (n) => {
    print(`${n}`);
  });
});
