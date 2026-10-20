// ledger: step 0, takes
// `sleep(seconds(n))`: the program goes on that many seconds later, twenty-four frames a second.
program(() => {
  let n = 0;
  while (n < 3) {
    sleep(seconds(2));
    n += 1;
  }
  print(`${n}`);
});
