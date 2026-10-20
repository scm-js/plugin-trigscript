// ledger: step 5, refused: the action Play WAV
// The action Play WAV of a clip made by `noise()` when the map is built: a burst.
const burst = noise(0.15, { volume: 0.4 }).fade(0, 0.1);
program(() => {
  playWav(burst, 0);
});
