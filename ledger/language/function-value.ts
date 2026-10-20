// ledger: step 1, takes
// A function kept as a value and chosen while the game runs: `const f = turns < 3 ? inc : dec; f(n)`.
function inc(n: number) {
  return n + 1;
}
function dec(n: number) {
  return n - 1;
}
program(() => {
  let n = 10;
  let turns = 0;
  while (turns < 5) {
    const f = turns < 3 ? inc : dec;
    n = f(n);
    n = f(n + 1);
    turns += 1;
  }
  print(`${n}`);
});
