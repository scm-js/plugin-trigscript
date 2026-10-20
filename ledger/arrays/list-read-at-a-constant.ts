// ledger: step 0, takes
// A list written in the script, read at a place written in the script, which is its value when the map is built:
// `PRICES[2]`.
const PRICES = [50, 75, 100, 150];
program(() => {
  let n = 0;
  while (n < PRICES[2]) n += 30;
  print(`${n}`);
});
