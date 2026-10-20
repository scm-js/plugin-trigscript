// ledger: step 5, takes
// The action Leader Board (Kills), the unit type from a value of the program.
program(() => {
  let kind: UnitType = units.ZergZergling;
  let wave = 3;
  if (wave > 2) kind = units.ZergHydralisk;
  leaderboardKills("Kills", kind);
});
