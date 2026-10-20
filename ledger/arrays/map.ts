// ledger: step 3, takes
// A new array of each value of another put through a function: `xs.map((x) => x * 2)`.
program(() => {
  const xs = [1, 2, 3];
  let v = 0;
  while (v < 10) v += 3;
  xs[0] = v;
  const ys = xs.map((x) => x * 2);
  print(`${ys[0]}`);
});
