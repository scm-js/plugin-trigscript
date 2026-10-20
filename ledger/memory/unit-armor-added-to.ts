// ledger: step 6, refused: a write of unit.armor
// A unit type's armour raised by one: `stats(…).armor += 1`.
program(() => {
  stats(units.TerranMarine).armor += 1;
});
