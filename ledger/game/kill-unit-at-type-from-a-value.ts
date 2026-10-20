// ledger: step 5, refused: the action Kill Unit At Location, its fields from values
// The action Kill Unit at Location, the unit type from a value of the program.
program(() => {
  let kind: UnitType = units.ZergZergling;
  let wave = 3;
  if (wave > 2) kind = units.ZergHydralisk;
  killUnitAt(P2, kind, "All", locations.Anywhere);
});
