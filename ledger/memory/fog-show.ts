// ledger: step 7, refused: a map of our own has one program; this script has 2
// The fog library: what was lit this frame kept for so many frames, and waited out: `await fog.show(2)`.
// The library adds a program of its own, the canvas that wipes the fog every frame.
import { fog } from "trigscript/fog";
program(async () => {
  fog.light(P1, 30, 20, 4);
  await fog.show(2);
});
