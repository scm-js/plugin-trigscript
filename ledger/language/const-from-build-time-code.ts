// ledger: step 0, takes
// A `const` worked out by code that runs when the map is built (an array's `reduce`, a loop), used in the program as a number.
const COSTS = [50, 75, 100, 150];
const TOTAL = COSTS.reduce((a, b) => a + b, 0);
program(() => {
  let spent = 0;
  spent += TOTAL;
  print(`${spent}`);
});
