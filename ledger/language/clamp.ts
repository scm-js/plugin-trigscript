// ledger: step 0, takes
// `clamp(value, low, high)`: the value kept within low … high.
program(() => {
  let n = -2;
  let total = 0;
  while (n < 8) {
    total += clamp(n, 0, 5);
    n += 1;
  }
  print(`${total}`);
});
