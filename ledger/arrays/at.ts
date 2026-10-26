// ledger: step 3, takes
// A value at a place counted from the end when below zero: `xs.at(-1)`.
program(() => {
  const xs = [1, 2, 3, 4];
  let v = 0;
  while (v < 10) v += 3;
  xs[3] = v;
  print(`${xs.at(-1) ?? 0}`);
});
