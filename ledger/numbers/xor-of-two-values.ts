// ledger: step 4, refused: ^ of two values
// The bits one of two values that change while the game runs has and the other has not: `a ^ b`.
program(() => {
  let a = 0;
  let b = 1;
  while (a < 50) {
    a += 9;
    b += 5;
  }
  print(`${a ^ b}`);
});
