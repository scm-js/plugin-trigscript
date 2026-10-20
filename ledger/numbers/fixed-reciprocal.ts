// ledger: step 4, refused: a quotient of fixed numbers
// A number written in the script divided by a number with a fraction: `1 / x`.
program(() => {
  let x = 0.5;
  while (x < 3) x += 0.75;
  const q = 1 / x;
  if (q < 0.5) print("below 0.5");
  else print("0.5 or more");
});
