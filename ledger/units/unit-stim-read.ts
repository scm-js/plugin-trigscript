// ledger: step 10, takes
// Frames of stim left on a unit, read: `u.stim`, here straight off a pick (`first(…)`).
program(() => {
  print(`${first({ owner: P1 })!.stim}`);
});
