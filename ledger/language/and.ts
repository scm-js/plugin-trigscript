// ledger: step 0, takes
// `&&` of two tests: true when both hold.
program(() => {
  let n = 0;
  let count = 0;
  while (n < 10) {
    if (n > 2 && n < 7) count += 1;
    n += 1;
  }
  print(`${count}`);
});
