// ledger: step 4, takes
// An array of `u16` cells, each within 0 … 65 535: a store below zero is 0.
program(() => {
  const xs: u16[] = [5, 5, 5];
  let i = 0;
  while (i < 2) i += 1;
  xs[i] -= 10;
  print(`${xs[i]}`);
});
