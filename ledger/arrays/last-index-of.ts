// ledger: step 3, takes
// Where a value is last in an array, −1 when it is not: `xs.lastIndexOf(v)`.
program(() => {
  const xs = [4, 8, 4, 8];
  let v = 0;
  while (v < 8) v += 4;
  xs[0] = 5;
  print(`${xs.lastIndexOf(v)}`);
});
