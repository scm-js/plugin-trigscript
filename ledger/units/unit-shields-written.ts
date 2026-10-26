// ledger: step 10, takes
// A unit's shield points, written: `u.shields = 0`.
program(() => {
  first({ owner: P1 })!.shields = 0;
});
