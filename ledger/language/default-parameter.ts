// ledger: step 1, takes
// A parameter with a default value, `step = 1`, used when the call leaves it out.
function advance(n: number, step = 1) {
  return n + step;
}
program(() => {
  let n = 0;
  let turns = 0;
  while (turns < 4) {
    n = advance(n);
    n = advance(n, 10);
    turns += 1;
  }
  print(`${n}`);
});
