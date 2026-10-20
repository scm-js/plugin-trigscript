// ledger: step 10, refused: a unit's owner
// Who owns a unit, read and compared with a player: `u.owner == P2`, here straight off a pick (`first(…)`).
program(() => {
  if (first({ owner: P1 })?.owner == P2) print("given");
});
