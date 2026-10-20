// ledger: step 3, takes
// An array of booleans, stored and tested at a place that changes while the game runs: `seen[i] = true`.
program(() => {
  const seen = [false, false, false, false];
  let i = 0;
  while (i < 4) {
    seen[i] = i > 1;
    i += 1;
  }
  let j = 0;
  while (j < 3) j += 1;
  if (seen[j]) print("seen");
  else print("not seen");
});
