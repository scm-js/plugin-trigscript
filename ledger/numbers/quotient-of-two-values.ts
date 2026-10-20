// ledger: step 4, takes
// A quotient of two values that change while the game runs, rounded towards zero: `a / b`.
program(() => {
  let a = 0;
  let b = 1;
  while (a < 20) {
    a += 7;
    b += 1;
  }
  print(`${a / b}`);
});
