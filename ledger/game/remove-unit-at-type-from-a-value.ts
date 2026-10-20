// ledger: step 5, takes
// The action Remove Unit at Location, the unit type from a value of the program.
program(() => {
  let kind: UnitType = units.ZergZergling;
  let wave = 3;
  if (wave > 2) kind = units.ZergHydralisk;
  removeUnitAt(P2, kind, "All", locations.Anywhere);
});
