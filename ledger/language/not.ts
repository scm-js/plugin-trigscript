// ledger: step 0, takes
// `!` turns a test around.
program(() => {
  let n = 0;
  let count = 0;
  while (n < 10) {
    if (!(n < 4)) count += 1;
    n += 1;
  }
  print(`${count}`);
});
