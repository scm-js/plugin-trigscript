// ledger: step 5, refused: the action Modify Unit Hanger Count, its fields from values
// The action Modify Unit Hanger Count, the unit type from a value of the program.
program(() => {
  let kind: UnitType = units.ProtossCarrier;
  let wave = 3;
  if (wave > 2) kind = units.ProtossReaver;
  modifyHangarCount(P1, kind, 4, "All", locations.Anywhere);
});
