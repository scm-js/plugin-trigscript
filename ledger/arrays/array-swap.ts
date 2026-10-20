// ledger: step 3, takes
// Two cells swapped by a pattern: `[xs[i], xs[j]] = [xs[j], xs[i]]`.
program(() => {
  const xs = [3, 4, 5];
  let i = 0;
  let j = 0;
  while (j < 2) j += 1;
  [xs[i], xs[j]] = [xs[j], xs[i]];
  print(`${xs[0]}`);
});
