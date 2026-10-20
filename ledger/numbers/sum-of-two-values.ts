// ledger: step 0, takes
// A sum of two values that change while the game runs: `a + b`.
program(() => {
  let a = 0;
  let b = 0;
  while (a < 20) {
    a += 3;
    b += 5;
  }
  print(`${a + b}`);
});
