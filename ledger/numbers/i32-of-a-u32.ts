// ledger: step 0, takes
// A `u32` read back as a signed number: `i32(x)`.
program(() => {
  let x: u32 = u32(0);
  let n = 0;
  while (n < 3) {
    x = u32(x - 1);
    n += 1;
  }
  if (i32(x) < 0) print("below zero");
  else print("not below zero");
});
