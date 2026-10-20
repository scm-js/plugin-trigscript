// ledger: step 4, refused: a u16 variable
// A `u16` variable, which stays within 0 … 65 535: stored below zero it is 0.
program(() => {
  let a: u16 = 5;
  let n = 0;
  while (n < 3) {
    a -= 4;
    n += 1;
  }
  print(`${a}`);
});
