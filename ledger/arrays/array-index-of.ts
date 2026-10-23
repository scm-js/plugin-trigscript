// ledger: step 3, takes
// Where a value is in an array of the program, −1 when it is not: `xs.indexOf(v)`.
program(() => {
  const xs = [4, 8, 15, 16];
  xs[0] = 5;
  let v = 0;
  while (v < 15) v += 5;
  print(`${xs.indexOf(v)}`);
});
