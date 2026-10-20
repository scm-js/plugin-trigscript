// ledger: step 6, refused: a write of player.upgrades
// A player's level of an upgrade: `stats(P1).upgrades[upgrades.*] = 3`.
program(() => {
  stats(P1).upgrades[upgrades.TerranInfantryWeapons] = 3;
});
