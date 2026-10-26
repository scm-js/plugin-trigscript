// ledger: step 0, takes
// Compound assignment that takes a step: `+=`, `-=`, and `<<=` by a constant.
program(() => {
  let n = 1;
  let turns = 0;
  while (n < 100) {
    n <<= 2;
    n += 1;
    n -= 2;
    turns += 1;
  }
  print(`${n} ${turns}`);
});
