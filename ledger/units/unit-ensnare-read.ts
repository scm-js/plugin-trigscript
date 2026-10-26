// ledger: step 10, takes
// Frames of Ensnare left on a unit, read: `u.ensnare`, here straight off a pick (`first(…)`).
program(() => {
  print(`${first({ owner: P1 })!.ensnare}`);
});
