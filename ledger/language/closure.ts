// ledger: step 9, takes
// A closure over a value worked out while the game runs: `adder(k)` gives a function that keeps its `k`.
function adder(k: number) {
  return (x: number) => x + k;
}
program(() => {
  let n = 0;
  while (n < 5) n += 1;
  const add = adder(n);
  let total = 0;
  while (total < 20) total = add(total);
  print(`${total}`);
});
