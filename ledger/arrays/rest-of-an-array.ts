// ledger: step 3, takes
// The rest of an array taken out by a pattern, an array of its own: `const [first, ...rest] = xs`.
program(() => {
  const xs = [5, 2, 8, 1];
  let v = 0;
  while (v < 10) v += 3;
  xs[0] = v;
  const [first, ...rest] = xs;
  print(`${first} ${rest[0]}`);
});
