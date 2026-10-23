// ledger: step 6, takes
// A unit type's mineral cost read from the game's tables: `stats(units.TerranMarine).minerals`.
program(() => {
  const cost = stats(units.TerranMarine).minerals;
  print(`${cost}`);
});
