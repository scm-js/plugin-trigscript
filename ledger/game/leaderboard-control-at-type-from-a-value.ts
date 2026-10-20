// ledger: step 5, takes
// The action Leader Board (Control at Location), the unit type from a value of the program.
program(() => {
  let kind: UnitType = units.TerranMarine;
  let wave = 3;
  if (wave > 2) kind = units.TerranFirebat;
  leaderboardControlAt("Men on the hill", kind, locations.Anywhere);
});
