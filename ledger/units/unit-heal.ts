// ledger: step 10, refused: a unit's verb (heal)
// A unit's hit points given back, up to its type's most: `u.heal(20)`.
program(() => {
  first({ owner: P1 })?.heal(20);
});
