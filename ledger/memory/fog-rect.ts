// ledger: step 7, takes
// The fog library: a rectangle of tiles lit for this frame, every side from values of the program:
// `fog.rect(P1, x, y, width, height)`.
// The library adds a program of its own, the canvas that wipes the fog every frame.
import { fog } from "trigscript/fog";
program(async () => {
  let tall = 4;
  while (tall < 12) {
    fog.rect(P1, 10, 20, 3, tall);
    await nextFrame();
    tall += 2;
  }
});
