// ledger: step 0, takes
// `switch` on a number that changes while the game runs, each `case` ending in `break`, and a `default`.
program(() => {
  let n = 0;
  let score = 0;
  while (n < 5) {
    switch (n) {
      case 0: score += 1; break;
      case 2: score += 10; break;
      default: score += 100; break;
    }
    n += 1;
  }
  print(`${score}`);
});
