// ledger: step 10, refused: a unit's stim written
// Stim started on a unit by writing its frames: `u.stim = 100`.
program(() => {
  first({ owner: P1 })!.stim = 100;
});
