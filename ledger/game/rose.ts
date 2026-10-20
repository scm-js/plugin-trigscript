// ledger: step 5, refused: rose()
// `rose(…)`: true on the frame its test becomes true, false until it becomes false and true again.
program(() => {
  let n = 0;
  let high = false;
  while (n < 6) {
    high = n > 2;
    if (rose(high)) print(`up at ${n}`);
    n += 1;
  }
});
