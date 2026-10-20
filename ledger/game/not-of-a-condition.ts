// ledger: step 5, takes
// A condition turned around by `not(…)`, worked out when the map is built: a program tests the
// flipped condition ("at least 1" becomes "at most 0").
program(() => {
  if (not(bring(P1, units.AnyUnit, locations.Anywhere, ">=", 1))) print("yes");
});
