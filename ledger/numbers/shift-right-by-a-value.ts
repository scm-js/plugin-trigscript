// ledger: step 4, refused: a shift by a value (>>)
// A value shifted right by a number that changes while the game runs: `a >> n`.
program(() => {
  let a = 1000;
  let n = 0;
  while (n < 5) {
    a += 9;
    n += 2;
  }
  print(`${a >> n}`);
});
