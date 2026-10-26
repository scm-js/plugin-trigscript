// ledger: step 1, takes
// A generic function, `function larger<T>(…)`: the type is gone in the map, the function the same for every call.
function larger<T extends number>(a: T, b: T): T {
  return a > b ? a : b;
}
program(() => {
  let n = 0;
  let total = 0;
  while (n < 4) {
    total += larger(n, 2);
    total += larger(5, n);
    n += 1;
  }
  print(`${total}`);
});
