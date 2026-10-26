// ledger: step 10, takes
// Ensnare put on a unit by writing its frames: `u.ensnare = 100`.
program(() => {
  first({ owner: P1 })!.ensnare = 100;
});
