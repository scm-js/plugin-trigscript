// ledger: step 0, takes
// `i32(x)`: the same 32 bits read as a signed number again.
program(() => {
  let n = u32(5);
  let count = 0;
  while (n > 0) {
    if (i32(n) < 3) count += 1;
    n -= 1;
  }
  print(`${count}`);
});
