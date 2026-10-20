// ledger: step 4, takes
// A value with bits set, as a value: `a | 1`.
program(() => {
  let a = 0;
  while (a < 50) a += 10;
  print(`${a | 1}`);
});
