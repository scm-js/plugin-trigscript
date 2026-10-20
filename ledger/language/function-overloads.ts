// ledger: step 1, takes
// A function with overload signatures: the types are checked, the one body is what runs.
function add(a: number): number;
function add(a: number, b: number): number;
function add(a: number, b = 1) {
  return a + b;
}
program(() => {
  let n = 0;
  let turns = 0;
  while (turns < 3) {
    n = add(n, 2);
    n = add(n, turns);
    turns += 1;
  }
  print(`${n}`);
});
