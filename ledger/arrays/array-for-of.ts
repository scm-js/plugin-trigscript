// ledger: step 3, takes
// A loop over the cells of an array of the program, within one frame: `for (const x of xs)`.
program(() => {
  const xs = [4, 8, 15, 16];
  xs[0] = 5;
  let total = 0;
  for (const x of xs) total += x;
  print(`${total}`);
});
