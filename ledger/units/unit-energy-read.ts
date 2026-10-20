// ledger: step 10, refused: a unit's energy
// A unit's energy, read: `u.energy`, here straight off a pick (`first(…)`).
program(() => {
  print(`${first({ owner: P1 })!.energy}`);
});
