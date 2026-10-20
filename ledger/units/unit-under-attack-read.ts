// ledger: step 10, refused: a unit's flag underAttack
// Whether something hit a unit in the last second or so: `u.underAttack`, here straight off a pick (`first(…)`).
program(() => {
  if (first({ owner: P1 })?.underAttack) print("hit");
});
