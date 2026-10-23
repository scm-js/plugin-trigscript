// ledger: step 10, takes
// Whether a unit is burrowed: `u.burrowed`, here straight off a pick (`first(…)`).
program(() => {
  if (first({ owner: P1 })?.burrowed) print("burrowed");
});
