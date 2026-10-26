// ledger: step 0, takes
// A value's negative: `-a`.
program(() => {
  let a = 0;
  while (a < 10) a += 3;
  const b = -a;
  print(`${b}`);
});
