// ledger: step 0, takes
// `===` and `!==`, the same as `==` and `!=` for numbers.
program(() => {
  let n = 0;
  let count = 0;
  while (n < 6) {
    if (n === 2) count += 1;
    if (n !== 4) count += 10;
    n += 1;
  }
  print(`${count}`);
});
