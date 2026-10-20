// ledger: step 6, refused: a location moved (centerLocation)
// The screen library: a picture made of rows of text when the map is built (`sprite`), drawn on a screen
// where the program says (`blit`).
import { Screen, sprite } from "trigscript/screen";
const SHIP = sprite([".1.", "111", "1.1"]);
program(async () => {
  const screen = new Screen(4, 4, 8, 8);
  let x = 2;
  screen.blit(SHIP, x, 4);
  screen.present();
});
