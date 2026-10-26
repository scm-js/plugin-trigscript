// ledger: step 10, takes
// A unit's type's most hit points, read: `u.maxHp`, here straight off a pick (`first(…)`).
program(() => {
  print(`${first({ owner: P1 })!.maxHp}`);
});
