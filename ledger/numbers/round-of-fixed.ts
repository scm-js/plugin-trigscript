// ledger: step 0, takes
// A number with a fraction rounded to the nearest whole number: `Math.round(x)`.
program(() => {
  let x = 0.5;
  while (x < 3) x += 0.75;
  print(`${Math.round(x)}`);
});
