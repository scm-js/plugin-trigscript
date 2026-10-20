// ledger: step 8, refused: a text repeated
// A text over again a number of times that changes while the game runs: `"■".repeat(n)`.
program(() => {
  let n = 0;
  while (n < 6) n += 2;
  print("■".repeat(n));
});
