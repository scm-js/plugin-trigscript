// ledger: step 5, takes
// The condition Kill as a test in an `if`: a player has killed so many units of a type.
program(() => {
  if (kill(P1, units.ZergZergling, ">=", 10)) print("yes");
});
