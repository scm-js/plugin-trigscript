// ledger: step 9, refused: an array that grows
// A copy of part of an array: `xs.slice(1, 3)`.
program(() => {
  const xs = [5, 2, 8, 1];
  let v = 0;
  while (v < 10) v += 3;
  xs[1] = v;
  const ys = xs.slice(1, 3);
  print(`${ys[0]}`);
});
