// ledger: step 9, refused: an array that grows
// An array that grows cut short, or emptied, by setting its length: `xs.length = 1`.
program(() => {
  const xs = [1, 2, 3];
  let v = 0;
  while (v < 10) v += 3;
  xs.push(v);
  xs.length = 1;
  print(`${xs[0]}`);
});
