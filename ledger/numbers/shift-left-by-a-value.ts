// ledger: step 4, refused: a shift by a value (<<)
// A value shifted left by a number that changes while the game runs: `1 << n`.
program(() => {
  let n = 0;
  while (n < 5) n += 2;
  print(`${1 << n}`);
});
