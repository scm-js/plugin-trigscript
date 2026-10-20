// ledger: step 3, takes
// Destructuring an array of numbers into variables: `const [a, b] = xs`.
program(() => {
  let xs = [1, 2, 3];
  xs[1] += 5;
  const [a, b] = xs;
  print(`${a} ${b}`);
});
