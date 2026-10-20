// ledger: step 4, refused: a quotient by a constant
// A value divided by a power of two written in the script, rounded towards zero as JavaScript does: `a / 4` is −2 for
// −9, where `a >> 2` is −3.
program(() => {
  let a = 0;
  while (a > -8) a -= 3;
  print(`${a / 4}`);
});
