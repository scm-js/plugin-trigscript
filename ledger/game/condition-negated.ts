// ledger: step 5, refused: the condition Bring
// A condition turned around with `!` in an `if`: `if (!bring(…))`, which works for every condition.
program(() => {
  if (!bring(P1, units.AnyUnit, locations.Anywhere, ">=", 1)) print("yes");
});
