// ledger: step 10, refused: a unit's stasis written
// A unit held in Stasis Field by writing its frames: `u.stasis = 100`.
program(() => {
  first({ owner: P1 })!.stasis = 100;
});
