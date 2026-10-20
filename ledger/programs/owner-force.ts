// ledger: step 7, refused: a map of our own has no per-player program yet
// A program that runs once for each player of a force: `{ owner: players.Force1 }`.
program(() => {
  print("for my force");
}, { owner: players.Force1 });
