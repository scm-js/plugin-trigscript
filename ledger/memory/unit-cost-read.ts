// ledger: step 6, refused: a read of unit.minerals
// A unit type's mineral cost read from the game's tables: `stats(units.TerranMarine).minerals`.
program(() => {
  const cost = stats(units.TerranMarine).minerals;
  print(`${cost}`);
});
