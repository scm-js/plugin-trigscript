// ledger: step 10, refused: a unit's maxShields
// A unit's type's most shield points, read: `u.maxShields`, here straight off a pick (`first(…)`).
program(() => {
  print(`${first({ owner: P1 })!.maxShields}`);
});
