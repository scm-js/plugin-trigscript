// ledger: step 10, takes
// The unit of a type nearest the centre of a location: `nearest(units.TerranMarine, there)`.
program(() => {
  nearest(units.TerranMarine, locations.Anywhere)?.kill();
});
