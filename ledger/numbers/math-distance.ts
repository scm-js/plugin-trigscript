// ledger: step 4, refused: a product of two values
// The distance between two points as the crow flies, from `trigscript/math`: `distance(x1, y1, x2, y2)`.
import { distance } from "trigscript/math";
program(() => {
  let x = 0;
  let y = 0;
  while (x < 10) {
    x += 3;
    y += 4;
  }
  const d = distance(0, 0, x, y);
  if (d > 19.5) print("more than 19.5");
  else print("19.5 or less");
});
