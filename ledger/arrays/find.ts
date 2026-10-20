// ledger: step 3, takes
// The first value of an array a function says yes to, or none: `xs.find((x) => x > 2) ?? -1`.
program(() => {
  const xs = [1, 2, 3, 4];
  let v = 0;
  while (v < 10) v += 3;
  xs[0] = v;
  print(`${xs.find((x) => x > 2) ?? -1}`);
});
