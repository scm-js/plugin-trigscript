// ledger: step 7, refused: a map of our own has one program; this script has 2
// The fog library: a picture made of rows of text when the map is built (`fog.picture`), lit for a frame.
// The library adds a program of its own, the canvas that wipes the fog every frame.
import { fog } from "trigscript/fog";
const heart = fog.picture([".##.##.", "#######", ".#####.", "..###.."]);
program(async () => {
  fog.light(P1, 60, 40, heart);
  await nextFrame();
});
