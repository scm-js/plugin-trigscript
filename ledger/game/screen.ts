// ledger: step 6, refused: a location moved (centerLocation)
// The screen library: a grid of pixels drawn by the program and shown on the map as units, a pixel
// each: `new Screen(x, y, width, height)`, `set`, `present()`.
import { Screen } from "trigscript/screen";
program(async () => {
  const screen = new Screen(4, 4, 8, 8);
  let x = 2;
  screen.set(x, 3, 2);
  screen.present();
});
