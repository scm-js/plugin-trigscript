// ledger: step 0, takes
// A value shifted right by a number written in the script, keeping its sign, as a value: `a >> 2`.
program(() => {
  let a = 0;
  while (a > -50) a -= 9;
  print(`${a >> 2}`);
});
