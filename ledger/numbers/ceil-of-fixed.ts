// ledger: step 0, takes
// A number with a fraction rounded up to a whole number: `Math.ceil(x)`.
program(() => {
  let x = 0.5;
  while (x < 3) x += 0.75;
  print(`${Math.ceil(x)}`);
});
