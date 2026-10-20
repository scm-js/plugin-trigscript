// ledger: step 7, takes
// The player a program runs as, named in it: `CurrentPlayer`, here a player's own minerals in a program for each.
program(() => {
  setResources(CurrentPlayer, "add", 50, "ore");
}, { owner: AllPlayers });
