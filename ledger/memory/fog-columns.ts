// ledger: step 7, refused: a map of our own has one program; this script has 2
// The fog library: columns lit for this frame, each as tall as an array of the program says, laid out
// when the map is built: `fog.columns(P1, x, y, layout, heights)` (a bar chart, a raycaster's walls).
// The library adds a program of its own, the canvas that wipes the fog every frame.
import { fog } from "trigscript/fog";
const VIEW = { count: 4, height: 16 } as const;
program(async () => {
  const heights = [4, 8, 12, 16];
  heights[0] = 6;
  fog.columns(P1, 1, 0, VIEW, heights);
  await nextFrame();
});
