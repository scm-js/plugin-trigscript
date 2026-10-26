// ledger: step 5, takes
// `once(…)`: true the first time its test holds, never again.
program(() => {
  let n = 0;
  let high = false;
  while (n < 6) {
    high = n > 2;
    if (once(high)) print(`first at ${n}`);
    n += 1;
  }
});
