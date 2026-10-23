// ledger: step 9, takes
// A copy of an array turned round, the array left as it was: `xs.toReversed()`.
program(() => {
  const xs = [5, 2, 8, 1];
  let v = 0;
  while (v < 10) v += 3;
  xs[0] = v;
  const ys = xs.toReversed();
  print(`${ys[3]} ${xs[0]}`);
});
