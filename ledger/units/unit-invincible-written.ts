// ledger: step 10, refused: a unit's invincible written
// A unit made invincible: `u.invincible = true`.
program(() => {
  first({ owner: P1 })!.invincible = true;
});
