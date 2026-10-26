// ledger: step 10, takes
// Whether a unit is cloaked: `u.cloaked`, here straight off a pick (`first(…)`).
program(() => {
  if (first({ owner: P1 })?.cloaked) print("cloaked");
});
