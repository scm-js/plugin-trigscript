// ledger: step 10, takes
// Two units compared: `a == b` when both name the same unit of the game.
program(() => {
  if (first({ owner: P1 }) == nearest(units.AnyUnit, locations.Anywhere, { owner: P1 })) print("the same");
});
