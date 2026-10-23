// ledger: step 10, takes
// How many units a unit has killed, read: `u.kills`, here straight off a pick (`first(…)`).
program(() => {
  print(`${first({ owner: P1 })!.kills}`);
});
