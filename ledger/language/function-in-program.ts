// ledger: step 1, takes
// A function declared inside the program, beside the variables it uses.
program(() => {
  let n = 0;
  function twice(x: number) {
    return x + x;
  }
  while (n < 50) n = twice(n) + 1;
  print(`${twice(n)}`);
});
