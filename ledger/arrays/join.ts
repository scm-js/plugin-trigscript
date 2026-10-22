// ledger: step 8, takes
// The values of an array of numbers as one text, with a separator between them: `xs.join(", ")`.
program(() => {
  const xs = [5, 2, 8];
  let v = 0;
  while (v < 10) v += 3;
  xs[0] = v;
  print(xs.join(", "));
});
