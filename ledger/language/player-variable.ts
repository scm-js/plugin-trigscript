// ledger: step 0, takes
// A player kept in a variable, changed and compared while the game runs: `let p: Player = P10`.
program(() => {
  let p: Player = P10;
  let n = 0;
  while (n < 3) {
    n += 1;
    if (n == 2) p = P11;
  }
  if (p == P11) print("eleven");
});
