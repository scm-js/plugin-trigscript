// ledger: step 10, refused: a unit
// Whether a pick found a unit that is still on the map: `if (first(…))`.
program(() => {
  if (first({ owner: P1, type: units.TerranMarine })) print("a marine");
});
