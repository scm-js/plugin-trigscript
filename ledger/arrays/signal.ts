// ledger: step 9, refused: an array that grows
// An event of the script's own from `trigscript/signals`: handlers added with `on` and run with `emit`.
import { Signal } from "trigscript/signals";
program(() => {
  const cleared = new Signal<number>();
  let total = 0;
  cleared.on((wave) => {
    total += wave;
  });
  let wave = 0;
  while (wave < 3) {
    wave += 1;
    cleared.emit(wave);
  }
  print(`${total}`);
});
