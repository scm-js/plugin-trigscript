// ledger: step 10, refused: an array that grows
// The units of a set that fit, kept in an array: `unitsOf(P1).filter((u) => u.hp < 20)`.
program(() => {
  const weak = unitsOf(P1).filter((u) => u.hp < 20);
  for (const u of weak) if (u) u.heal(10);
});
