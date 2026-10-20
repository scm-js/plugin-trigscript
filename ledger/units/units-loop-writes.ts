// ledger: step 10, refused: a loop over units
// A loop over units that writes to each: `for (const u of unitsOf(P2)) u.hp = u.maxHp / 2`.
program(() => {
  for (const u of unitsOf(P2)) u.hp = u.maxHp / 2;
});
