// ledger: step 10, refused: a unit's energy written
// A unit's energy, written: `u.energy = 200`.
program(() => {
  first({ owner: P1 })!.energy = 200;
});
