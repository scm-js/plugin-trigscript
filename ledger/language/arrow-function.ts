// ledger: step 1, takes
// A function written as an arrow kept in a `const`: `const twice = (x: number) => x + x`.
const twice = (x: number) => x + x;
program(() => {
  let n = 1;
  while (n < 50) n = twice(n) + 1;
  print(`${twice(n)}`);
});
