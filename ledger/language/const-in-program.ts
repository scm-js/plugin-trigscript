// ledger: step 0, takes
// A `const` inside the program holding a value worked out while the game runs: it cannot be changed after.
program(() => {
  let n = 0;
  while (n < 7) n += 1;
  const twice = n + n;
  print(`${twice}`);
});
