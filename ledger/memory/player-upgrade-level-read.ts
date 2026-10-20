// ledger: step 6, refused: a read of player.upgrades
// A player's level of an upgrade, read: `stats(P1).upgrades[upgrades.*]`.
program(() => {
  const level = stats(P1).upgrades[upgrades.TerranInfantryWeapons];
  print(`${level}`);
});
