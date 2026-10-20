// ledger: step 4, refused: a quotient of fixed numbers
// A quotient of two numbers with a fraction that change while the game runs: `x / y`.
program(() => {
  let x = 0.5;
  let y = 0.25;
  while (x < 3) {
    x += 0.75;
    y += 0.5;
  }
  const q = x / y;
  if (q > 1.5) print("more than 1.5");
  else print("1.5 or less");
});
