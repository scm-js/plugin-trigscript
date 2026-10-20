// ledger: step 10, refused: a unit's stasis
// Frames of Stasis Field left on a unit, read: `u.stasis`, here straight off a pick (`first(…)`).
program(() => {
  print(`${first({ owner: P1 })!.stasis}`);
});
