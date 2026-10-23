// ledger: step 4, takes
// A value with bits flipped, as a value: `a ^ 5`.
program(() => {
  let a = 0;
  while (a < 50) a += 9;
  print(`${a ^ 5}`);
});
