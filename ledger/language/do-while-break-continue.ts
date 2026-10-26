// ledger: step 0, takes
// `break` and `continue` inside a `do … while` loop.
program(() => {
  let n = 0;
  let total = 0;
  do {
    n += 1;
    if (n == 2) continue;
    if (n > 5) break;
    total += n;
  } while (n < 10);
  print(`${total}`);
});
