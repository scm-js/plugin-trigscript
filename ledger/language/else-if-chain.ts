// ledger: step 0, takes
// A chain of `else if`: the first test that holds picks the branch.
program(() => {
  let n = 0;
  let small = 0;
  let middle = 0;
  let large = 0;
  while (n < 12) {
    if (n < 4) small += 1;
    else if (n < 8) middle += 1;
    else large += 1;
    n += 1;
  }
  print(`${small} ${middle} ${large}`);
});
