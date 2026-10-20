// ledger: step 10, refused: select()
// What a player has selected made one unit, as if they had clicked it: `select(P1, u)`.
program(() => {
  select(P1, first({ owner: P1, type: units.TerranMarine })!);
});
