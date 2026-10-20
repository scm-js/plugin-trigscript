// ledger: step 6, refused: a write of upgrade.minerals
// An upgrade's cost and time written: `stats(upgrades.*)`.
program(() => {
  stats(upgrades.TerranInfantryArmor).minerals = 50;
  stats(upgrades.TerranInfantryArmor).gas = 50;
  stats(upgrades.TerranInfantryArmor).time = 30;
});
