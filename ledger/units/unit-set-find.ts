// ledger: step 10, takes
// The first unit of a set that fits, or none: `unitsOf(P1).find((u) => u.energy >= 75)`.
program(() => {
  const caster = unitsOf(P1).find((u) => u.energy >= 75);
  if (caster) caster.energy = 0;
});
