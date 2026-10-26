// ledger: step 10, takes
// Whether a unit's order is aimed at another unit: `u.hasTarget`.
program(() => {
  if (first({ owner: P1 })?.hasTarget) print("busy with something");
});
