// ledger: step 5, takes
// The action Play WAV of clips laid over one another by `mixdown()` when the map is built: one clip.
const kick = tone([[0, 150], [0.08, 45]], 0.2, { volume: 0.6 });
const hat = noise(0.03, { volume: 0.2 });
const groove = mixdown([{ clip: kick, at: 0 }, { clip: hat, at: 0.25 }, { clip: kick, at: 0.5 }]);
program(() => {
  playWav(groove, 0);
});
