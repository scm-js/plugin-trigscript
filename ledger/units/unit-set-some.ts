// ledger: step 10, takes
// Whether any unit of a set fits: `unitsOf(P1).some((u) => u.hp < 20)`.
program(() => {
  if (unitsOf(P1).some((u) => u.hp < 20)) print("one is hurt");
});
