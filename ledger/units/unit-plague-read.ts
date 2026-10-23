// ledger: step 10, takes
// Frames of Plague left on a unit, read: `u.plague`, here straight off a pick (`first(…)`).
program(() => {
  print(`${first({ owner: P1 })!.plague}`);
});
