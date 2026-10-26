// ledger: step 10, takes
// A unit's remaining build time, written: `u.buildTime = 24` finishes it in a second.
program(() => {
  for (const u of unitsOf(P1, { type: units.Buildings })) if (u.buildTime > 24) u.buildTime = 24;
});
