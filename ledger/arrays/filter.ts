// ledger: step 9, takes
// A new array of the values of another a function says yes to: `xs.filter((x) => x > 2)`.
program(() => {
  const xs = [1, 2, 3, 4];
  let v = 0;
  while (v < 10) v += 3;
  xs[0] = v;
  const ys = xs.filter((x) => x > 2);
  print(`${ys[0]}`);
});
