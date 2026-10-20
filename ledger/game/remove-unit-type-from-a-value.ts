// ledger: step 5, refused: the action Remove Unit, its fields from values
// The action Remove Unit, the unit type from a value of the program.
program(() => {
  let kind: UnitType = units.ZergZergling;
  let wave = 3;
  if (wave > 2) kind = units.ZergHydralisk;
  removeUnit(P2, kind);
});
