// ledger: step 10, takes
// A unit's hit points, read: `u.hp`, here straight off a pick (`first(…)`).
program(() => {
  print(`${first({ owner: P1 })!.hp}`);
});
