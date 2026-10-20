// ledger: step 0, takes
// A number goes round past 2 147 483 647 to −2 147 483 648, as a 32-bit number does.
program(() => {
  let a = 2147483640;
  let n = 0;
  while (n < 10) {
    a += 1;
    n += 1;
  }
  print(`${a}`);
});
