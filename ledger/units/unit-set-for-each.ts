// ledger: step 10, refused: a loop over units
// Every unit of a set handed to a function: `unitsOf(P1).forEach((u) => u.heal(10))`.
program(() => {
  unitsOf(P1).forEach((u) => u.heal(10));
});
