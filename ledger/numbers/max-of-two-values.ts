// ledger: step 0, takes
// The larger of two values that change while the game runs: `Math.max(a, b)`.
program(() => {
  let a = 0;
  let b = 30;
  while (a < 20) {
    a += 3;
    b -= 2;
  }
  print(`${Math.max(a, b)}`);
});
