// ledger: step 5, refused: the action Set Deaths, its fields from values
// The action Set Deaths, the unit type (which counter) from a value of the program.
program(() => {
  let kind: UnitType = units.TerranMarine;
  let wave = 3;
  if (wave > 2) kind = units.TerranFirebat;
  setDeaths(P1, kind, "add", 1);
});
