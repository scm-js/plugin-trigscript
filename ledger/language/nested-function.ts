// ledger: step 1, takes
// A function declared inside another function, using its parameter.
function total(n: number) {
  function sq(k: number) {
    return k + k;
  }
  return sq(n) + sq(n + 1);
}
program(() => {
  let n = 0;
  let sum = 0;
  while (n < 3) {
    sum += total(n);
    sum += total(n + 5);
    n += 1;
  }
  print(`${sum}`);
});
