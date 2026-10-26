// ledger: step 10, takes
// A unit held in Stasis Field by writing its frames: `u.stasis = 100`.
program(() => {
  first({ owner: P1 })!.stasis = 100;
});
