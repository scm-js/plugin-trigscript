// ledger: step 6, refused: a read of unit.organic
// A unit type's flag tested in an `if`: `if (stats(units.TerranMarine).organic)`.
program(() => {
  if (stats(units.TerranMarine).organic) print("a Medic heals it");
});
