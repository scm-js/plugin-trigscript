// ledger: step 5, refused: the action Give Units to Player, its fields from values
// The action Give Units to Player, the unit type from a value of the program.
program(() => {
  let kind: UnitType = units.TerranMarine;
  let wave = 3;
  if (wave > 2) kind = units.TerranFirebat;
  giveUnits(P1, P2, kind, "All", locations.Anywhere);
});
