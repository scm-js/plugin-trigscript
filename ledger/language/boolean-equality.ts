// ledger: step 0, takes
// Two booleans compared, `a == b`, `a != b`.
program(() => {
  let n = 0;
  let same = 0;
  let a = false;
  let b = true;
  while (n < 6) {
    a = n > 2;
    b = n < 4;
    if (a == b) same += 1;
    if (a != b) same += 10;
    n += 1;
  }
  print(`${same}`);
});
