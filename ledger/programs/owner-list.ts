// ledger: step 7, refused: a map of our own has no per-player program yet
// A program that runs once for each player of a list: `{ owner: [P1, P2] }`.
program(() => {
  print("for each of us");
}, { owner: [P1, P2] });
