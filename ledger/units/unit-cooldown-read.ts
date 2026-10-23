// ledger: step 10, takes
// Frames until a unit can attack again, read: `u.cooldown`, here straight off a pick (`first(…)`).
program(() => {
  print(`${first({ owner: P1 })!.cooldown}`);
});
