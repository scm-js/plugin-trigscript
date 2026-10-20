// ledger: step 3, takes
// The place of the first value of an array a function says yes to, −1 for none: `xs.findIndex((x) => x > 2)`.
program(() => {
  const xs = [1, 2, 3, 4];
  let v = 0;
  while (v < 10) v += 3;
  xs[1] = v;
  print(`${xs.findIndex((x) => x > 2)}`);
});
