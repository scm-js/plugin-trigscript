// ledger: step 6, refused: a write of memory.vision.countdown
// The game's vision countdown written: `memory.vision.countdown = 1` wipes the fog on the next frame.
program(() => {
  memory.vision.countdown = 1;
});
