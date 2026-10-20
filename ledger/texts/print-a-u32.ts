// ledger: step 2, takes
// A `u32` in a printed text, read from 0 up: `u32(-1)` prints 4294967295.
program(() => {
  let a = 0;
  while (a > -1) a -= 1;
  const x: u32 = u32(a);
  print(`${x}`);
});
