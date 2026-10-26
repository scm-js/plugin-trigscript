// ledger: step 5, takes
// The action Play WAV of a clip made by `fm()` when the map is built: a bell.
const bell = fm("E5", 1, { ratio: 3.5, index: [[0, 6], [1, 0.3]], volume: 0.3 }).fade(0, 0.5);
program(() => {
  playWav(bell, 0);
});
