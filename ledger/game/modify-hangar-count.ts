// ledger: step 5, refused: the action Modify Unit Hanger Count
// The action Modify Unit Hanger Count: Interceptors or Scarabs added to the units at a location.
program(() => {
  modifyHangarCount(P1, units.ProtossCarrier, 4, "All", locations.Anywhere);
});
