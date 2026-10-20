// ledger: step 0, takes
// A value without its sign: `Math.abs(a)`.
program(() => {
  let a = 5;
  while (a > -10) a -= 4;
  print(`${Math.abs(a)}`);
});
