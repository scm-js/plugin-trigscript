// ledger: step 4, refused: a remainder by a constant
// A remainder by a whole number written in the script: `a % 7`.
program(() => {
  let a = 0;
  while (a < 50) a += 9;
  print(`${a % 7}`);
});
