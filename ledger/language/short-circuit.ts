// ledger: step 1, takes
// `&&` that does not ask its right side when the left is false: a call on the right runs only then.
program(() => {
  let calls = 0;
  function big(n: number) {
    calls += 1;
    return n > 3;
  }
  let n = 0;
  let count = 0;
  while (n < 6) {
    if (n > 1 && big(n)) count += 1;
    if (n > 4 || big(n + 1)) count += 10;
    n += 1;
  }
  print(`${count} ${calls}`);
});
