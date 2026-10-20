// ledger: step 5, takes
// The action Play WAV of a clip made by `tone()` when the map is built: a beep.
const beep = tone("A5", 0.1, { wave: "square", volume: 0.3 }).fade(0, 0.05);
program(() => {
  playWav(beep, 0);
});
