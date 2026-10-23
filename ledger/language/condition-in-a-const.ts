// ledger: step 5, takes
// Conditions of the game joined by && and kept in a const, asked where the const is tested.
program(() => {
  const both = command(P1, units.TerranMarine, ">=", 1) && bring(P1, units.TerranMarine, locations.Anywhere, ">=", 1);
  if (both) print("both");
});
