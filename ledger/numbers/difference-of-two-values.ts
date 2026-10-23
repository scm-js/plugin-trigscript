// ledger: step 0, takes
// A difference of two values that change while the game runs: `a - b`.
program(() => {
  let a = 0;
  let b = 0;
  while (a < 20) {
    a += 7;
    b += 2;
  }
  print(`${a - b}`);
});
