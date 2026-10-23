// ledger: step 0, takes
// `u32(x)`: the same 32 bits read as a number from 0 up, so `-1` compares as the largest.
program(() => {
  let n = 3;
  let count = 0;
  while (n > -3) {
    if (u32(n) > 100) count += 1;
    n -= 1;
  }
  print(`${count}`);
});
