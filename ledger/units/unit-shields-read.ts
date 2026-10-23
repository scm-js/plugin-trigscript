// ledger: step 10, takes
// A unit's shield points, read: `u.shields`, here straight off a pick (`first(…)`).
program(() => {
  print(`${first({ owner: P1 })!.shields}`);
});
