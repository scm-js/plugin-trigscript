// ledger: step 10, takes
// Frames left of a unit's or a building's making: `u.buildTime`, 0 once it is complete.
program(() => {
  const cc = first({ type: units.TerranCommandCenter });
  if (cc && cc.buildTime > 0) print(`${cc.buildTime} to go`);
});
