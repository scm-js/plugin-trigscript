// ledger: step 6, takes
// A weapon's other fields written: upgrade bonus, cooldown, hits per attack, least range.
program(() => {
  stats(weapons.GaussRifle).bonus = 2;
  stats(weapons.GaussRifle).cooldown = 10;
  stats(weapons.GaussRifle).factor = 2;
  stats(weapons.GaussRifle).minRange = 0;
});
