// ledger: step 3, takes
// A function run for each value of an array: `xs.forEach((x) => { total += x; })`.
program(() => {
  const xs = [1, 2, 3, 4];
  let v = 0;
  while (v < 10) v += 3;
  xs[0] = v;
  let total = 0;
  xs.forEach((x) => {
    total += x;
  });
  print(`${total}`);
});
