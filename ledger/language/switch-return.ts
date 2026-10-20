// ledger: step 1, takes
// A `switch` inside a function whose cases `return` the function's result.
function price(kind: number) {
  switch (kind) {
    case 0: return 50;
    case 1: return 75;
    default: return 100;
  }
}
program(() => {
  let n = 0;
  let total = 0;
  while (n < 4) {
    total += price(n);
    total += price(n + 1);
    n += 1;
  }
  print(`${total}`);
});
