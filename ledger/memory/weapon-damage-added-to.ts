// ledger: step 6, refused: a write of weapon.damage
// A weapon's damage raised: `stats(weapons.GaussRifle).damage += 2`.
program(() => {
  stats(weapons.GaussRifle).damage += 2;
});
