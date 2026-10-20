// ledger: step 5, takes
// The action Set Deaths, the unit type (which counter) from a value of the program.
program(() => {
  let kind: UnitType = units.TerranMarine;
  let wave = 3;
  if (wave > 2) kind = units.TerranFirebat;
  setDeaths(P1, kind, "add", 1);
});
