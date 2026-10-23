// ledger: step 0, takes
// `?:` choosing between two numbers, its test asked while the game runs.
program(() => {
  let n = 0;
  let total = 0;
  while (n < 6) {
    total += n < 3 ? 1 : 10;
    n += 1;
  }
  print(`${total}`);
});
