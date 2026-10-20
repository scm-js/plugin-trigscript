// ledger: step 7, refused: a program owned by P12: a program runs for players 1 to 8, All Players or a force
// A program owned by Player 12, who runs no triggers: `{ owner: P12 }`, refused as the Python side refuses it.
program(() => {
  print("never");
}, { owner: P12 });
