// ledger: step 0, takes
// A number used as a test, `while (n)`: true when it is not 0.
program(() => {
  let n = 3;
  let turns = 0;
  while (n) {
    n -= 1;
    turns += 1;
  }
  print(`${turns}`);
});
