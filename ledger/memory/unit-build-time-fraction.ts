// ledger: step 6, refused: a write of unit.buildTime
// A unit type's build time written as a fraction known when the map is built: `buildTime = 1.5`.
program(() => {
  stats(units.TerranMarine).buildTime = 1.5;
});
