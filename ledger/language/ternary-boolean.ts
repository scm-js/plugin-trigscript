// ledger: step 0, takes
// `?:` choosing between two booleans, its test asked while the game runs.
program(() => {
  let n = 0;
  let count = 0;
  let pick = false;
  while (n < 6) {
    pick = n > 2 ? n < 4 : n > 0;
    if (pick) count += 1;
    n += 1;
  }
  print(`${count}`);
});
