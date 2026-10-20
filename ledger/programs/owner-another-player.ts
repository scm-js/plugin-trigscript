// ledger: step 0, takes
// A program that runs as another player than Player 1: `program(…, { owner: P2 })`.
program(() => {
  print("for P2");
}, { owner: P2 });
