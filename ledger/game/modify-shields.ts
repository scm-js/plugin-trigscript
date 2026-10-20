// ledger: step 5, takes
// The action Modify Unit Shield Points: units at a location get a percentage of their shields.
program(() => {
  modifyShields(P1, units.ProtossZealot, 100, "All", locations.Anywhere);
});
