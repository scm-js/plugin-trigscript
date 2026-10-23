// ledger: step 3, takes
// The last value of an array a function says yes to, and its place: `xs.findLast(…)`, `xs.findLastIndex(…)`.
program(() => {
  const xs = [1, 2, 3, 4];
  let v = 0;
  while (v < 10) v += 3;
  xs[0] = v;
  print(`${xs.findLast((x) => x < 4) ?? -1} ${xs.findLastIndex((x) => x > 9)}`);
});
