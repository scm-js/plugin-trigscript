// ledger: step 7, refused: a map of our own has no per-player program yet
// A program run once for each of several players at the same time, `{ owner: [P4, P5, P6] }`, each with variables of their own.
program(
  () => {
    let n = 0;
    while (n < 3) n += 1;
    print(`${n}`, { to: CurrentPlayer });
  },
  { owner: [P4, P5, P6] },
);
