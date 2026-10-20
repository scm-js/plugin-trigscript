// ledger: step 0, takes
// `Math.min`, `Math.max` and `Math.abs` of values that change while the game runs.
program(() => {
  let n = -3;
  let total = 0;
  while (n < 4) {
    total += Math.min(n, 1) + Math.max(n, 0) + Math.abs(n);
    n += 1;
  }
  print(`${total}`);
});
