// ledger: step 0, takes
// `n++` and `++n` as values: the number before the step, and the one after.
program(() => {
  let n = 0;
  let total = 0;
  while (total < 20) {
    total += n++;
    total += ++n;
  }
  print(`${total} ${n}`);
});
