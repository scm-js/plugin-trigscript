// ledger: step 6, refused: a write of unit.supplyProvided
// Supply a unit type provides, for the ones made after.
program(() => {
  stats(units.TerranSupplyDepot).supplyProvided = 10;
});
