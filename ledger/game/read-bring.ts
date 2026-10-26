// ledger: step 5, takes
// A condition that compares a quantity, read as a value: `bring(P1, unit, location)`.
program(() => {
  const n = bring(P1, units.AnyUnit, locations.Anywhere);
  print(`${n}`);
});
