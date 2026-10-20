// ledger: step 3, takes
// A `Map` keyed by ids of the game, at a key that changes while the game runs: `get`, `set`, `has`, `delete` and
// `size`.
program(() => {
  const bounty = new Map<UnitType, number>();
  let type: UnitType = units.ZergZergling;
  let n = 0;
  while (n < 5) {
    bounty.set(type, n);
    type = units.ZergHydralisk;
    n += 2;
  }
  bounty.delete(units.ZergZergling);
  if (bounty.has(type)) print(`${bounty.get(type) ?? 0} ${bounty.size}`);
});
