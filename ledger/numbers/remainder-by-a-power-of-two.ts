// ledger: step 4, refused: a remainder by a constant
// A remainder by a power of two written in the script, which keeps the sign of the value as JavaScript's does: `a % 8`
// is −1 for −9, where `a & 7` is 7.
program(() => {
  let a = 0;
  while (a > -8) a -= 3;
  print(`${a % 8}`);
});
