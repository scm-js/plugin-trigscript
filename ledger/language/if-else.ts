// ledger: step 0, takes
// `if` with an `else`, on a number that changes while the game runs.
program(() => {
  let n = 0;
  while (n < 7) {
    if (n < 3) n += 2;
    else n += 1;
  }
  print(`${n}`);
});
