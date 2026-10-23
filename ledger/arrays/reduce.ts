// ledger: step 3, takes
// The values of an array put together into one, a function at a time: `xs.reduce((so, x) => so + x, 0)`.
program(() => {
  const xs = [1, 2, 3, 4];
  let v = 0;
  while (v < 10) v += 3;
  xs[0] = v;
  const total = xs.reduce((so, x) => so + x, 0);
  print(`${total}`);
});
