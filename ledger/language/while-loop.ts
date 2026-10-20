// ledger: step 0, takes
// A `while` loop over a number, within one frame.
program(() => {
  let n = 0;
  while (n < 10) n += 3;
  print(`${n}`);
});
