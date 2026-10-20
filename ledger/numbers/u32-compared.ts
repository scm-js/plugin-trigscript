// ledger: step 0, takes
// A number read as a `u32`, 0 … 4 294 967 295, compared as one: `u32(a) > 100` is true for a number below zero.
program(() => {
  let a = 0;
  while (a > -10) a -= 3;
  if (u32(a) > 100) print("large");
  else print("small");
});
