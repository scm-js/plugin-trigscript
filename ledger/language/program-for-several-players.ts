// ledger: step 7, takes
// A program run once for each of several players at the same time, `{ owner: [P4, P5, P6] }`, each with variables of their own.
program(
  () => {
    let n = 0;
    while (n < 3) n += 1;
    print(`${n}`, { to: CurrentPlayer });
  },
  { owner: [P4, P5, P6] },
);
