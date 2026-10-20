// ledger: step 3, refused: a shift by a constant (>>) as a value
// A cell read at a place worked out by a shift, as the halves of a list are: `xs[a >> 1]` (stored there, or with the
// place kept in a variable first, it is taken).
program(() => {
  const xs = [1, 2, 3, 4, 5, 6, 7];
  xs[0] = 9;
  let a = 0;
  while (a < 10) a += 3;
  print(`${xs[a >> 1]}`);
});
