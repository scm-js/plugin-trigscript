// ledger: step 5, takes
// The action Create Unit with Properties, the unit type from a value of the program.
program(() => {
  let kind: UnitType = units.TerranMarine;
  let wave = 3;
  if (wave > 2) kind = units.TerranFirebat;
  createUnitWithProperties(P1, kind, 1, locations.Anywhere, 1);
});
