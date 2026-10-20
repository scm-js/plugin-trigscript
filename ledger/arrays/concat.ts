// ledger: step 9, refused: an array that grows
// A new array of two arrays one after the other: `xs.concat(ys)`.
program(() => {
  const xs = [5, 2];
  const ys = [8, 1];
  let v = 0;
  while (v < 10) v += 3;
  ys[0] = v;
  const zs = xs.concat(ys);
  print(`${zs[2]}`);
});
