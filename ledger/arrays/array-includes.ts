// ledger: step 3, takes
// Whether an array of the program has a value, a loop the game runs: `xs.includes(v)`.
program(() => {
  const xs = [4, 8, 15, 16];
  xs[0] = 5;
  let v = 0;
  while (v < 15) v += 5;
  if (xs.includes(v)) print("found");
  else print("not found");
});
