// ledger: step 10, refused: a loop over units
// Whether every unit of a set fits: `unitsOf(P1).every((u) => u.hp == u.maxHp)`.
program(() => {
  if (unitsOf(P1).every((u) => u.hp == u.maxHp)) print("all well");
});
