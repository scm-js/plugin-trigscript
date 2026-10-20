// ledger: step 6, refused: a write of unit.gas
// A unit type's gas cost written: `stats(units.TerranGhost).gas = 50`.
program(() => {
  stats(units.TerranGhost).gas = 50;
});
