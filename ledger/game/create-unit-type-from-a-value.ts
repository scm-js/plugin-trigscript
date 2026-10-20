// ledger: step 5, takes
// The action Create Unit, the unit type from a value of the program.
program(() => {
  let kind: UnitType = units.TerranMarine;
  let wave = 3;
  if (wave > 2) kind = units.TerranFirebat;
  createUnit(P1, kind, 1, locations.Anywhere);
});
