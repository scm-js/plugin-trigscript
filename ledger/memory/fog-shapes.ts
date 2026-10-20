// ledger: step 7, refused: a map of our own has one program; this script has 2
// The fog library's brushes, `SHAPES`: the tiles each size of brush reveals, for a renderer of the
// script's own (`cover(picture, SHAPES)`), worked out when the map is built.
// The library adds a program of its own, the canvas that wipes the fog every frame.
import { SHAPES } from "trigscript/fog";
const brushes = cover(["#####", "#####", "#####", "#####"], SHAPES);
const sizes = brushes.map((b) => b.shape + 1);
program(() => {
  let i = 0;
  let sum = 0;
  while (i < sizes.length) {
    sum += sizes[i];
    i += 1;
  }
  print(`${sum}`);
});
