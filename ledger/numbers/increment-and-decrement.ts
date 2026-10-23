// ledger: step 0, takes
// A variable counted up and down, and changed by an amount: `n++`, `n--`, `n += k`, `n -= k`.
program(() => {
  let n = 0;
  let k = 1;
  while (k < 6) {
    n++;
    n += k;
    n -= 2;
    k++;
  }
  n--;
  print(`${n}`);
});
