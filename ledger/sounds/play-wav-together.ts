// ledger: step 5, takes
// The action Play WAV of clips the game plays together, turned down by `together()` when the map is built
// so that they never add up past the peak.
const [low, high] = together([{ clip: tone("C4", 0.5, { volume: 0.8 }), at: 0 }, { clip: tone("G4", 0.5, { volume: 0.8 }), at: 0.25 }]);
program(() => {
  playWav(low, 0);
  sleep(frames(6));
  playWav(high, 0);
});
