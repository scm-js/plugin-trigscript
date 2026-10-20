// ledger: step 0, takes
// A number read as a `u32` the JavaScript way: `a >>> 0`, which costs nothing.
program(() => {
  let a = 0;
  while (a > -10) a -= 3;
  if (a >>> 0 > 100) print("large");
  else print("small");
});
