// ledger: step 1, takes
// An arrow function handed to a function as an argument and called inside it: worked out where it is called.
function twice(f: (n: number) => number, n: number) {
  return f(f(n));
}
program(() => {
  let n = 1;
  let turns = 0;
  while (turns < 3) {
    n = twice((x) => x + x + 1, n);
    turns += 1;
  }
  print(`${n}`);
});
