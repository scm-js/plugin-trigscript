// ledger: step 5, takes
// The action Play WAV of a clip made by `pluck()` when the map is built: a plucked string.
const harp = pluck("G3", 0.8, { brightness: 0.6 });
program(() => {
  playWav(harp, 0);
});
