// ledger: step 5, takes
// The action Leader Board Goal (Control at Location), the unit type from a value of the program.
program(() => {
  let kind: UnitType = units.TerranMarine;
  let wave = 3;
  if (wave > 2) kind = units.TerranFirebat;
  leaderboardGoalControlAt("Men on the hill", kind, 10, locations.Anywhere);
});
