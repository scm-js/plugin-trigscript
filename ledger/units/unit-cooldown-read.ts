// ledger: step 10, refused: a unit's cooldown
// Frames until a unit can attack again, read: `u.cooldown`, here straight off a pick (`first(…)`).
program(() => {
  print(`${first({ owner: P1 })!.cooldown}`);
});
