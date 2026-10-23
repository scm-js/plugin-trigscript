// ledger: step 3, takes
// An array of a fixed length made from another and more: `[...xs, 9]`.
program(() => {
  const xs = [3, 4, 5];
  let i = 0;
  while (i < 2) i += 1;
  xs[i] = 8;
  const ys = [...xs, 9];
  print(`${ys[2] + ys[3]}`);
});
