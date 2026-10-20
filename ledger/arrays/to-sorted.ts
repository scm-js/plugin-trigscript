// ledger: step 9, refused: an array that grows
// A sorted copy of an array, the array left as it was: `xs.toSorted((a, b) => a - b)`.
program(() => {
  const xs = [5, 2, 8, 1];
  let v = 0;
  while (v < 10) v += 3;
  xs[0] = v;
  const ys = xs.toSorted((a, b) => a - b);
  print(`${ys[0]} ${xs[0]}`);
});
