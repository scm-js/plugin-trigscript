// ledger: step 0, takes
// A value times a whole number written in the script: `a * 3`.
program(() => {
  let a = 0;
  let n = 0;
  while (n < 5) {
    a = n * 3;
    n += 1;
  }
  print(`${a}`);
});
