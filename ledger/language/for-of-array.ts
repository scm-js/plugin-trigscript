// ledger: step 3, takes
// `for (const x of xs)` over a fixed-length array of the program's, its cells changed while the game runs.
program(() => {
  let xs = [3, 5, 8];
  let n = 0;
  while (n < 3) {
    xs[n] += n;
    n += 1;
  }
  let total = 0;
  for (const x of xs) total += x;
  print(`${total}`);
});
