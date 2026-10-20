// ledger: step 10, refused: a unit's hp written
// A unit's hit points read and written in one: `u.hp += 10`.
program(() => {
  first({ owner: P1 })!.hp += 10;
});
