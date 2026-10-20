// ledger: step 7, refused: a map of our own has no per-player program yet
// The player a program runs as, named in it: `CurrentPlayer`, here a player's own minerals in a program for each.
program(() => {
  setResources(CurrentPlayer, "add", 50, "ore");
}, { owner: AllPlayers });
