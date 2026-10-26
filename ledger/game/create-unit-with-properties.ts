// ledger: step 5, takes
// The action Create Unit with Properties, all its fields known when the map is built: units made with
// one of the map's unit property sets (hit points, energy, …).
program(() => {
  createUnitWithProperties(P1, units.TerranMarine, 1, locations.Anywhere, 1);
});
