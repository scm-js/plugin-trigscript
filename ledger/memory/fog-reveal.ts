// ledger: step 7, takes
// The fog library: the whole map lit once, so that from then on dark is fog, not black: `fog.reveal(P1)`.
// The library adds a program of its own, the canvas that wipes the fog every frame.
import { fog } from "trigscript/fog";
program(async () => {
  fog.reveal(P1);
});
