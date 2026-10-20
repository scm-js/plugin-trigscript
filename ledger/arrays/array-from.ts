// ledger: step 3, takes
// An array made from a length written in the script and a function of each place:
// `Array.from({ length: 4 }, (_, i) => i * 2)`.
program(() => {
  const xs = Array.from({ length: 4 }, (_, i) => i * 2);
  let i = 0;
  while (i < 3) i += 1;
  xs[0] = i;
  print(`${xs[i] + xs[0]}`);
});
