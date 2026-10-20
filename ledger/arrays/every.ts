// ledger: step 3, takes
// Whether a function says yes to every value of an array: `xs.every((x) => x > 1)`.
program(() => {
  const xs = [1, 2, 3, 4];
  let v = 0;
  while (v < 10) v += 3;
  xs[0] = v;
  if (xs.every((x) => x > 1)) print("all are");
  else print("not all are");
});
