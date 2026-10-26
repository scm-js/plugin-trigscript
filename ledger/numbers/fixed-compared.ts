// ledger: step 0, takes
// A number with a fraction compared with a whole number and with another fraction, below zero too: `x < -1`.
program(() => {
  let x = 0.75;
  while (x > -2) x -= 0.5;
  if (x < -1) print("below -1");
  if (x >= -2.25) print("not below -2.25");
});
