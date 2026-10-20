// ledger: step 10, refused: a unit's verb (damage)
// A unit's hit points taken down by so many: `u.damage(20)`.
program(() => {
  first({ owner: P1 })?.damage(20);
});
