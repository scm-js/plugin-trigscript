// ledger: step 10, takes
// Maelstrom put on a unit by writing its frames: `u.maelstrom = 100`.
program(() => {
  first({ owner: P1 })!.maelstrom = 100;
});
