// ledger: step 10, takes
// Frames of Lockdown left on a unit, read: `u.lockdown`, here straight off a pick (`first(…)`).
program(() => {
  print(`${first({ owner: P1 })!.lockdown}`);
});
