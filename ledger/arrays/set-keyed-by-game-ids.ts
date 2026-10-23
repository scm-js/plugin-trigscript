// ledger: step 3, takes
// A `Set` of ids of the game, at a key that changes while the game runs: `add`, `has`, `delete` and `size`.
program(() => {
  const seen = new Set<UnitType>();
  let type: UnitType = units.ZergZergling;
  let n = 0;
  while (n < 5) {
    seen.add(type);
    type = units.ZergHydralisk;
    n += 2;
  }
  seen.delete(units.ZergZergling);
  if (seen.has(type)) print(`${seen.size}`);
});
