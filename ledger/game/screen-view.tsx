// ledger: step 8, takes
// The screen library: a screen's pixels shown in the text lines, a coloured square each:
// `<ScreenView screen={s} width={…} height={…} />`.
import { Screen, ScreenView } from "trigscript/screen";
program(async () => {
  const screen = new Screen(0, 0, 4, 3);
  let x = 1;
  screen.set(x, 1, 3);
  print(<ScreenView screen={screen} width={4} height={3} />);
});
