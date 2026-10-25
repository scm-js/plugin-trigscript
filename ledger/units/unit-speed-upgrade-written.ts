// ledger: step 10, takes
// A unit's speed upgrade, switched on by a write: `u.speedUpgrade = true`, without the upgrade.
program(() => {
  for (const u of unitsOf(P1, { type: units.ZergZergling })) u.speedUpgrade = true;
});
