// ledger: step 4, takes
// The bits either of two values that change while the game runs has: `a | b`.
program(() => {
  let a = 0;
  let b = 1;
  while (a < 50) {
    a += 9;
    b += 5;
  }
  print(`${a | b}`);
});
