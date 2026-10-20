// ledger: step 10, refused: a loop over units
// A set of units folded into one number: `unitsOf(P1).reduce((sum, u) => sum + u.hp, 0)`.
program(() => {
  const total = unitsOf(P1).reduce((sum, u) => sum + u.hp, 0);
  print(`${total}`);
});
