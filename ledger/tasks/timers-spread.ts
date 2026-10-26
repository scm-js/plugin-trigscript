// ledger: step 1, takes
// trigscript/timers: `for await (const i of spread(count, { per: 4 }))`, a count from 0 spread over frames, so many a frame.
import { spread } from "trigscript/timers";
program(async () => {
  let count = 2;
  while (count < 10) count += 3;
  let s = 0;
  for await (const i of spread(count, { per: 4 })) s += i;
  print(`${s}`);
});
