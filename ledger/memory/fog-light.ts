// ledger: step 7, refused: a map of our own has one program; this script has 2
// The fog library: a disc of fog lit for this frame, its size a value of the program:
// `light(P1, x, y, size)`.
// The library adds a program of its own, the canvas that wipes the fog every frame.
import { light } from "trigscript/fog";
program(async () => {
  let size = 1;
  while (size < 6) {
    light(P1, 30, 20, size);
    await nextFrame();
    size += 1;
  }
});
