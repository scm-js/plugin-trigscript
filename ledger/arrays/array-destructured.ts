// ledger: step 3, takes
// The items of an array taken out into variables: `const [a, b] = xs`.
program(() => {
  const xs = [3, 4, 5];
  let i = 0;
  while (i < 3) {
    xs[i] += i;
    i += 1;
  }
  const [a, b] = xs;
  print(`${a + b}`);
});
