// ledger: step 4, takes
// A value's low bits kept, as a value: `a & 7`.
program(() => {
  let a = 0;
  while (a < 50) a += 9;
  print(`${a & 7}`);
});
