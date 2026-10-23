// ledger: step 0, takes
// A `do … while` loop: the body runs once before the test is asked.
program(() => {
  let n = 0;
  do {
    n += 4;
  } while (n < 10);
  print(`${n}`);
});
