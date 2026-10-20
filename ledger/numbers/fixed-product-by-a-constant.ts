// ledger: step 4, refused: a product of fixed numbers
// A number with a fraction times a fraction written in the script: `x * 1.5`.
program(() => {
  let x = 0.5;
  while (x < 3) x += 0.75;
  const p = x * 1.5;
  if (p > 4) print("more than 4");
  else print("4 or less");
});
