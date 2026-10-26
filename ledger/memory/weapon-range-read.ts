// ledger: step 6, takes
// A weapon's range in pixels read from the game's tables: `stats(weapons.GaussRifle).range`.
program(() => {
  const range = stats(weapons.GaussRifle).range;
  print(`${range}`);
});
