// ledger: step 10, refused: a unit's maelstrom
// Frames of Maelstrom left on a unit, read: `u.maelstrom`, here straight off a pick (`first(…)`).
program(() => {
  print(`${first({ owner: P1 })!.maelstrom}`);
});
