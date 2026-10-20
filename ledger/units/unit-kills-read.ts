// ledger: step 10, refused: a unit's kills
// How many units a unit has killed, read: `u.kills`, here straight off a pick (`first(…)`).
program(() => {
  print(`${first({ owner: P1 })!.kills}`);
});
