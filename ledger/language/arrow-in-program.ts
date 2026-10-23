// ledger: step 1, takes
// An arrow function declared in the program that reads and writes the program's variables.
program(() => {
  let total = 0;
  const add = (n: number) => {
    total += n;
  };
  let n = 0;
  while (n < 4) {
    add(n);
    add(2);
    n += 1;
  }
  print(`${total}`);
});
