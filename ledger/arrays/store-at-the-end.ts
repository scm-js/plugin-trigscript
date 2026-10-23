// ledger: step 9, takes
// A value stored one past the end of an array, which grows it as `push` does: `xs[xs.length] = v`.
program(() => {
  const xs = [1, 2];
  let v = 0;
  while (v < 10) v += 3;
  xs[xs.length] = v;
  print(`${xs[2]}`);
});
