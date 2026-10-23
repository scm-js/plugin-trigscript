// ledger: step 3, takes
// Whether a function says yes to any value of an array: `xs.some((x) => x > 10)`.
program(() => {
  const xs = [1, 2, 3, 4];
  let v = 0;
  while (v < 10) v += 3;
  xs[0] = v;
  if (xs.some((x) => x > 10)) print("one is");
  else print("none is");
});
