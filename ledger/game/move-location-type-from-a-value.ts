// ledger: step 5, takes
// The action Move Location, the unit type from a value of the program.
program(() => {
  let kind: UnitType = units.TerranMarine;
  let wave = 3;
  if (wave > 2) kind = units.TerranFirebat;
  moveLocation(P1, kind, locations.Anywhere, locations.Anywhere);
});
