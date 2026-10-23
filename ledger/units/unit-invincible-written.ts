// ledger: step 10, takes
// A unit made invincible: `u.invincible = true`.
program(() => {
  first({ owner: P1 })!.invincible = true;
});
