// ledger: step 5, refused: a read of the game (Accumulate)
// The action Set Resources, the amount read from the game when the line runs: `setResources(P2, "set", minerals(P1), "ore")`.
program(() => {
  setResources(P2, "set", minerals(P1), "ore");
});
