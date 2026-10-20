// ledger: step 8, refused: JSX made while the game runs
// The screen library's colours in the text lines, `TEXT_COLORS`: a pixel's colour, 1 to 7, as a square of text.
import { TEXT_COLORS } from "trigscript/screen";
program(async () => {
  let c = 2;
  c += 1;
  print(<line><cell color={TEXT_COLORS[c]} /></line>);
});
