// ledger: step 10, takes
// Frames left of a unit's defensive matrix: `u.matrix`, 0 without one.
program(() => {
  const u = first({ owner: P1 });
  if (u && u.matrix > 0) print("shielded");
});
