// ledger: step 3, takes
// A list written in the script, looked up at a value that changes while the game runs: `PRICES[i]`.
const PRICES = [50, 75, 100, 150];
program(() => {
  let i = 0;
  while (i < 2) i += 1;
  print(`${PRICES[i]}`);
});
