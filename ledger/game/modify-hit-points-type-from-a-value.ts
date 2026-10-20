// ledger: step 5, refused: the action Modify Unit Hit Points, its fields from values
// The action Modify Unit Hit Points, the unit type from a value of the program.
program(() => {
  let kind: UnitType = units.TerranMarine;
  let wave = 3;
  if (wave > 2) kind = units.TerranFirebat;
  modifyHitPoints(P1, kind, 100, "All", locations.Anywhere);
});
