// ledger: step 5, takes
// The condition Bring as a test in an `if`: a player has units of a type at a location.
program(() => {
  if (bring(P1, units.TerranMarine, locations.Anywhere, ">=", 5)) print("yes");
});
