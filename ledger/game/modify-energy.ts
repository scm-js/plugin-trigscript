// ledger: step 5, refused: the action Modify Unit Energy
// The action Modify Unit Energy: units at a location get a percentage of their energy.
program(() => {
  modifyEnergy(P1, units.TerranGhost, 100, "All", locations.Anywhere);
});
