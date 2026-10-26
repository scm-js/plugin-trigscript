// ledger: step 1, takes
// A comparison of the program's variables handed to a boolean parameter.
function step(n: number, early: boolean) {
  return early ? n + 1 : n;
}
program(() => {
  let turns = 1;
  let n = 5;
  n = step(n, turns < 2);
  n = step(n, turns > 2);
  print(`${n}`);
});
