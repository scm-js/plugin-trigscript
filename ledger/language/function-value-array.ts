// ledger: step 3, takes
// An array of functions, one picked by an index that changes while the game runs.
function inc(n: number) {
  return n + 1;
}
function triple(n: number) {
  return n + n + n;
}
program(() => {
  const steps = [inc, triple];
  let n = 1;
  let which = 0;
  let turns = 0;
  while (turns < 4) {
    n = steps[which](n);
    n = steps[1 - which](n);
    which = 1 - which;
    turns += 1;
  }
  print(`${n}`);
});
