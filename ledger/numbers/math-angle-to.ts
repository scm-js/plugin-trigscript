// ledger: step 4, refused: Math.atan2
// The angle from one point to another, in radians, from `trigscript/math`: `angleTo(x1, y1, x2, y2)`.
import { angleTo } from "trigscript/math";
program(() => {
  let x = 0;
  let y = 0;
  while (x < 10) {
    x += 3;
    y += 4;
  }
  const a = angleTo(0, 0, x, y);
  if (a > 0.9) print("more than 0.9");
  else print("0.9 or less");
});
