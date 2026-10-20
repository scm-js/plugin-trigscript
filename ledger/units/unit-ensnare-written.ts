// ledger: step 10, refused: a unit's ensnare written
// Ensnare put on a unit by writing its frames: `u.ensnare = 100`.
program(() => {
  first({ owner: P1 })!.ensnare = 100;
});
