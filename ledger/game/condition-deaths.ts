// ledger: step 5, takes
// The condition Deaths as a test in an `if`: the counter a map keeps in the death table.
program(() => {
  if (deaths(P1, units.TerranMarine, ">=", 3)) print("yes");
});
