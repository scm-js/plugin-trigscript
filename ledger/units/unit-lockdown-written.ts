// ledger: step 10, refused: a unit's lockdown written
// Lockdown put on a unit by writing its frames: `u.lockdown = 100`.
program(() => {
  first({ owner: P1 })!.lockdown = 100;
});
