// ledger: step 10, takes
// The nearest unit of any type that one player owns: `nearest(units.AnyUnit, there, { owner: P2 })`.
program(() => {
  nearest(units.AnyUnit, locations.Anywhere, { owner: P2 })?.kill();
});
