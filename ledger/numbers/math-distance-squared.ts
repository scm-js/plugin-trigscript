// ledger: step 4, refused: a product of two values
// The distance between two points squared, a whole number, from `trigscript/math`: `distanceSq(x1, y1, x2, y2)`.
import { distanceSq } from "trigscript/math";
program(() => {
  let x = 0;
  let y = 0;
  while (x < 10) {
    x += 3;
    y += 4;
  }
  print(`${distanceSq(0, 0, x, y)}`);
});
