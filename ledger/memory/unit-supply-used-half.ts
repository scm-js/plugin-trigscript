// ledger: step 6, refused: a write of unit.supplyUsed
// Supply a unit type takes, a half: `stats(units.ZergZergling).supplyUsed = 0.5`.
program(() => {
  stats(units.ZergZergling).supplyUsed = 0.5;
});
