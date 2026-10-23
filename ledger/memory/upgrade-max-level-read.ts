// ledger: step 6, takes
// How many times an upgrade can be researched, read: `stats(upgrades.*).maxLevel`.
program(() => {
  const most = stats(upgrades.TerranInfantryArmor).maxLevel;
  print(`${most}`);
});
