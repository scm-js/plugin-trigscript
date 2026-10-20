// ledger: step 3, takes
// An array sorted in place by a function that compares two values: `xs.sort((a, b) => a - b)`.
program(() => {
  const xs = [5, 2, 8, 1];
  let v = 0;
  while (v < 10) v += 3;
  xs[0] = v;
  xs.sort((a, b) => a - b);
  print(`${xs[0]} ${xs[3]}`);
});
