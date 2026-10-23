// ledger: step 0, takes
// `sleep(cycles(n))`, the older word for `frames(n)`.
program(() => {
  let n = 0;
  while (n < 4) {
    sleep(cycles(3));
    n += 1;
  }
  print(`${n}`);
});
