// ledger: step 0, takes
// The comparisons `<`, `<=`, `>`, `>=`, `==` and `!=` of two values that change while the game runs.
program(() => {
  let a = 0;
  let b = 5;
  let count = 0;
  while (a < 10) {
    if (a <= b) count += 1;
    if (a > b) count += 10;
    if (a >= b) count += 100;
    if (a == b) count += 1000;
    if (a != b) count += 10000;
    a += 1;
  }
  print(`${count}`);
});
