// ledger: step 9, takes
// An array that grows made from another that grows and more: `[...xs, 9]`.
program(() => {
  const xs: number[] = [];
  let v = 0;
  while (v < 10) {
    xs.push(v);
    v += 3;
  }
  const ys = [...xs, 9];
  print(`${ys.length}`);
});
