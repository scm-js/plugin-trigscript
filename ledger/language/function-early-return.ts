// ledger: step 1, takes
// `return` from the middle of a function: what follows it in the function does not run.
function cost(n: number) {
  if (n > 3) return 100;
  if (n > 1) return 10;
  return 1;
}
program(() => {
  let n = 0;
  let total = 0;
  while (n < 6) {
    total += cost(n);
    n += 1;
  }
  total += cost(total);
  print(`${total}`);
});
