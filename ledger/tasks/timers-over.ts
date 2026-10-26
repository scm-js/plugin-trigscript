// ledger: step 3, takes
// trigscript/timers: `for await (const x of over(list, { per: 2 }))`, a loop over an array spread over frames, so many elements a frame.
import { over } from "trigscript/timers";
program(async () => {
  const xs = [1, 2, 3, 4, 5];
  let k = 1;
  while (k < 4) {
    xs[k] = k * 4;
    k += 1;
  }
  let s = 0;
  for await (const x of over(xs, { per: 2 })) s += x;
  print(`${s}`);
});
