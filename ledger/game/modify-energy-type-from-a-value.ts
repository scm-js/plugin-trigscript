// ledger: step 5, refused: the action Modify Unit Energy, its fields from values
// The action Modify Unit Energy, the unit type from a value of the program.
program(() => {
  let kind: UnitType = units.TerranGhost;
  let wave = 3;
  if (wave > 2) kind = units.TerranMedic;
  modifyEnergy(P1, kind, 100, "All", locations.Anywhere);
});
