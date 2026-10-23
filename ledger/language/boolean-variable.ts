// ledger: step 0, takes
// A boolean variable, set from a test while the game runs and tested later.
program(() => {
  let n = 0;
  let seen = false;
  while (n < 5) {
    seen = n == 3;
    if (seen) print("three");
    n += 1;
  }
});
