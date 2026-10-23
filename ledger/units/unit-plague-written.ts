// ledger: step 10, takes
// Plague put on a unit by writing its frames: `u.plague = 100`.
program(() => {
  first({ owner: P1 })!.plague = 100;
});
