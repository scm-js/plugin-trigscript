// ledger: step 5, takes
// The action Move Unit, the unit type from a value of the program.
program(() => {
  let kind: UnitType = units.TerranMarine;
  let wave = 3;
  if (wave > 2) kind = units.TerranFirebat;
  moveUnit(P1, kind, "All", locations.Anywhere, locations.Anywhere);
});
