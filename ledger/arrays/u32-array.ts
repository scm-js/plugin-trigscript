// ledger: step 3, takes
// An array of `u32` cells, read from 0 up: a cell set to −1 is larger than 100.
program(() => {
  const xs: u32[] = [u32(0), u32(0), u32(0)];
  let i = 0;
  while (i < 2) i += 1;
  xs[i] = u32(-1);
  if (xs[i] > 100) print("large");
  else print("small");
});
