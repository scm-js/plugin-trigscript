// ledger: step 10, refused: a unit's resources
// What a mineral field or a geyser still holds, read: `u.resources`, here straight off a pick (`first(…)`).
program(() => {
  print(`${first({ owner: P1 })!.resources}`);
});
