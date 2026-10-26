// ledger: step 10, takes
// Irradiate put on a unit by writing its frames: `u.irradiate = 100`.
program(() => {
  first({ owner: P1 })!.irradiate = 100;
});
