// ledger: step 4, refused: a shift by a value (>>>)
// A value shifted right by a number that changes while the game runs, its top bits zero: `a >>> n`.
program(() => {
  let a = 0;
  let n = 20;
  while (a > -50) {
    a -= 9;
    n += 2;
  }
  print(`${a >>> n}`);
});
