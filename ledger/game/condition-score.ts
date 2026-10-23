// ledger: step 5, takes
// The condition Score as a test in an `if`: a player has so many points of a kind.
program(() => {
  if (score(P1, "kills", ">=", 1000)) print("yes");
});
