// ledger: step 10, takes
// A unit's rank, written: `u.rank = 5` (its panel shows the type's rank five up).
program(() => {
  first({ owner: P1 })!.rank = 5;
});
