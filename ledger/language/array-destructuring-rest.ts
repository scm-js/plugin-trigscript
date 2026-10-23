// ledger: step 3, takes
// Destructuring the first cell of an array and the rest into another: `const [first, ...rest] = xs`.
program(() => {
  let xs = [1, 2, 3];
  xs[2] += 5;
  const [first, ...rest] = xs;
  print(`${first} ${rest[1]}`);
});
