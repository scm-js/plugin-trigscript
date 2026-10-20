// ledger: step 10, refused: a unit's maelstrom written
// Maelstrom put on a unit by writing its frames: `u.maelstrom = 100`.
program(() => {
  first({ owner: P1 })!.maelstrom = 100;
});
