// ledger: step 4, takes
// An array of `u8` cells, each within 0 … 255: a store below zero is 0, above 255 is 255.
program(() => {
  const xs: u8[] = [250, 250, 250];
  let i = 0;
  while (i < 2) i += 1;
  xs[i] += 10;
  print(`${xs[i]}`);
});
