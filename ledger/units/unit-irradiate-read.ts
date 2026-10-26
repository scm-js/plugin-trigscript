// ledger: step 10, takes
// Frames of Irradiate left on a unit, read: `u.irradiate`, here straight off a pick (`first(…)`).
program(() => {
  print(`${first({ owner: P1 })!.irradiate}`);
});
