// ledger: step 5, refused: the action Modify Unit Hit Points
// The action Modify Unit Hit Points: units at a location get a percentage of their hit points.
program(() => {
  modifyHitPoints(P2, units.ZergZergling, 50, "All", locations.Anywhere);
});
