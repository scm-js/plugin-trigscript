// ledger: step 10, takes
// Lockdown put on a unit by writing its frames: `u.lockdown = 100`.
program(() => {
  first({ owner: P1 })!.lockdown = 100;
});
