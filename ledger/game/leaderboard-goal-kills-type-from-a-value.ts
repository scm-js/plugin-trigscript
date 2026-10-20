// ledger: step 5, takes
// The action Leader Board Goal (Kills), the unit type from a value of the program.
program(() => {
  let kind: UnitType = units.ZergZergling;
  let wave = 3;
  if (wave > 2) kind = units.ZergHydralisk;
  leaderboardGoalKills("Kill 50", kind, 50);
});
