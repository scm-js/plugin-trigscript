// ledger: step 5, takes
// The action Modify Unit Shield Points, the unit type from a value of the program.
program(() => {
  let kind: UnitType = units.ProtossZealot;
  let wave = 3;
  if (wave > 2) kind = units.ProtossDragoon;
  modifyShields(P1, kind, 100, "All", locations.Anywhere);
});
