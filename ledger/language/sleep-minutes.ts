// ledger: step 0, takes
// `sleep(minutes(n))`: the program goes on that many minutes later.
program(() => {
  let n = 0;
  while (n < 2) {
    sleep(minutes(1));
    n += 1;
  }
  print(`${n}`);
});
