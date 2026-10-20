// ledger: step 0, takes
// `?:` inside another `?:`.
program(() => {
  let n = 0;
  let total = 0;
  while (n < 9) {
    total += n < 3 ? 1 : n < 6 ? 10 : 100;
    n += 1;
  }
  print(`${total}`);
});
