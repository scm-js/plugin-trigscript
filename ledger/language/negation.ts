// ledger: step 0, takes
// A number turned negative, `-n`, while the game runs.
program(() => {
  let n = 4;
  let total = 0;
  while (n > 0) {
    total += -n;
    n -= 1;
  }
  print(`${total}`);
});
