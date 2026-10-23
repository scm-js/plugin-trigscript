// ledger: step 0, takes
// A value shifted left by a number written in the script, as a value: `a << 2` (the value times 4).
program(() => {
  let a = 0;
  let n = 0;
  while (n < 5) {
    a = n << 2;
    n += 1;
  }
  print(`${a}`);
});
