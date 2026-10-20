// ledger: step 4, takes
// The bits two values that change while the game runs both have: `a & b`.
program(() => {
  let a = 0;
  let b = 1;
  while (a < 50) {
    a += 9;
    b += 5;
  }
  print(`${a & b}`);
});
