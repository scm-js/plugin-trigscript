// ledger: step 8, takes
// The code of a character of a text, at a place that changes while the game runs: `"Marine".charCodeAt(i)`.
program(() => {
  let i = 0;
  while (i < 3) i += 2;
  print(`${"Marine".charCodeAt(i)}`);
});
