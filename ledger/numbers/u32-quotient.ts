// ledger: step 4, takes
// A `u32` divided, as an unsigned number: `u32(a) / 2` of −2 is 2 147 483 647.
program(() => {
  let a = 0;
  while (a > -2) a -= 1;
  const q: u32 = u32(a) / 2;
  if (q > 1000) print("large");
  else print("small");
});
