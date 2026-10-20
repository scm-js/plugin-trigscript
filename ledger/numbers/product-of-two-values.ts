// ledger: step 4, takes
// A product of two values that change while the game runs: `a * b`.
program(() => {
  let a = 1;
  let i = 1;
  while (i < 5) {
    a = a * i;
    i += 1;
  }
  print(`${a}`);
});
