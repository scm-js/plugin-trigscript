// ledger: step 10, refused: a unit's flag burrowed
// Whether a unit is burrowed: `u.burrowed`, here straight off a pick (`first(…)`).
program(() => {
  if (first({ owner: P1 })?.burrowed) print("burrowed");
});
