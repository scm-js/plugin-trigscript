// ledger: step 9, refused: an array that grows
// A value added at the end of an array, which grows: `xs.push(v)`.
program(() => {
  const xs: number[] = [];
  let v = 0;
  while (v < 10) {
    xs.push(v);
    v += 3;
  }
  print(`${xs[2]}`);
});
