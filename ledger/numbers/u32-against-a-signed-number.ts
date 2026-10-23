// ledger: step 0, takes
// A `u32` compared with a plain number below zero, exactly: any `u32` is larger than −1, however its bits read signed.
program(() => {
  let a = 0;
  let n = 0;
  while (a > -10) {
    a -= 3;
    n -= 1;
  }
  const x: u32 = u32(a);
  if (x > n) print("larger");
  else print("not larger");
});
