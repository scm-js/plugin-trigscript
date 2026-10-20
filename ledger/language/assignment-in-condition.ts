// ledger: step 0, takes
// An assignment used as a value inside a test: `while ((n = n + 2) < 9)`.
program(() => {
  let n = 0;
  let turns = 0;
  while ((n = n + 2) < 9) turns += 1;
  print(`${n} ${turns}`);
});
