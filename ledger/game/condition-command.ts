// ledger: step 5, takes
// The condition Command as a test in an `if`: a player has so many units of a type anywhere.
program(() => {
  if (command(P1, units.TerranMarine, ">=", 5)) print("yes");
});
