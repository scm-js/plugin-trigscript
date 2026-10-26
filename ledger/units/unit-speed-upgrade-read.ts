// ledger: step 10, takes
// Whether a unit moves at its upgraded speed: `u.speedUpgrade`.
program(() => {
  if (first({ owner: P1 })?.speedUpgrade) print("boosted");
});
