// ledger: step 6, refused: a write of unit.minerals
// A unit type's mineral cost written: `stats(units.TerranMarine).minerals = 25`.
program(() => {
  stats(units.TerranMarine).minerals = 25;
});
