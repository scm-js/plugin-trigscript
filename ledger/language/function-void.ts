// ledger: step 1, takes
// A function with no result that changes the program's variables: called as a statement.
program(() => {
  let total = 0;
  function add(n: number) {
    total += n;
  }
  let n = 0;
  while (n < 4) {
    add(n);
    add(1);
    n += 1;
  }
  print(`${total}`);
});
