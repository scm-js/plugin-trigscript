// ledger: step 4, takes
// A `u8` variable, which stays within 0 … 255: stored below zero it is 0, above 255 it is 255.
program(() => {
  let a: u8 = 250;
  let n = 0;
  while (n < 3) {
    a += 4;
    n += 1;
  }
  print(`${a}`);
});
