// ledger: step 5, refused: the action Play WAV
// The action Play WAV of one of two clips, chosen by a value of the program.
const low = tone("C4", 0.1, { volume: 0.3 });
const high = tone("C5", 0.1, { volume: 0.3 });
program(() => {
  let n = 3;
  if (n > 2) playWav(high, 0);
  else playWav(low, 0);
});
