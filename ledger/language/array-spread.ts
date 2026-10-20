// ledger: step 3, takes
// An array made from another with `...`: `[...xs, 4]`, of a fixed length.
program(() => {
  let xs = [1, 2, 3];
  xs[0] += 5;
  const ys = [...xs, 4];
  let total = 0;
  for (const y of ys) total += y;
  print(`${total}`);
});
