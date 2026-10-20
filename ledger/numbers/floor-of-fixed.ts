// ledger: step 0, takes
// A number with a fraction rounded down to a whole number: `Math.floor(x)`.
program(() => {
  let x = 0.5;
  while (x < 3) x += 0.75;
  print(`${Math.floor(x)}`);
});
