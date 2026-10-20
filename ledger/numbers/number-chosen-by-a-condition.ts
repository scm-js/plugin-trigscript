// ledger: step 0, takes
// One number or another, by a test while the game runs: `a > b ? a : b + 1`.
program(() => {
  let a = 0;
  let b = 12;
  while (a < 20) {
    a += 3;
    b += 1;
  }
  const c = a > b ? a : b + 1;
  print(`${c}`);
});
