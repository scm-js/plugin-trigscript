// ledger: step 5, takes
// A leader board's label made while the game runs: a number of the program in it.
program(() => {
  let goal = 10;
  goal += 5;
  leaderboardControl(`Marines (goal ${goal})`, units.TerranMarine);
});
