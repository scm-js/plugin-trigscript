// ledger: step 10, takes
// A unit's hit points read and written in one: `u.hp += 10`.
program(() => {
  first({ owner: P1 })!.hp += 10;
});
