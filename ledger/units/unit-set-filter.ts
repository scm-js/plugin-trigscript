// ledger: step 10, refused: a loop over units
// The units of a set that fit, kept in an array: `unitsOf(P1).filter((u) => u.hp < 20)`.
program(() => {
  const weak = unitsOf(P1).filter((u) => u.hp < 20);
  for (const u of weak) if (u) u.heal(10);
});
