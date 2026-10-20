// ledger: step 4, refused: a quotient by a constant
// A value divided by a whole number written in the script, rounded towards zero: `a / 7`.
program(() => {
  let a = 0;
  while (a < 50) a += 9;
  print(`${a / 7}`);
});
