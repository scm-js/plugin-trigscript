// ledger: step 0, takes
// The distance between two points along the axes, |dx| + |dy|, from `trigscript/math`: `manhattan(x1, y1, x2, y2)`.
import { manhattan } from "trigscript/math";
program(() => {
  let x = 0;
  let y = 0;
  while (x < 10) {
    x += 3;
    y -= 4;
  }
  print(`${manhattan(0, 0, x, y)}`);
});
