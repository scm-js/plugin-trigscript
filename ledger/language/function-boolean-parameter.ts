// ledger: step 1, takes
// A function that takes a boolean parameter, given a boolean variable.
function step(n: number, up: boolean) {
  if (up) return n + 1;
  return n - 1;
}
program(() => {
  let n = 5;
  let turns = 0;
  let up = true;
  while (turns < 6) {
    up = turns < 2;
    n = step(n, up);
    n = step(n, false);
    turns += 1;
  }
  print(`${n}`);
});
