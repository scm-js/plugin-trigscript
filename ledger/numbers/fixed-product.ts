// ledger: step 4, takes
// A product of two numbers with a fraction that change while the game runs: `x * y`.
program(() => {
  let x = 0.5;
  let y = 1.25;
  while (x < 3) {
    x += 0.75;
    y += 0.5;
  }
  const p = x * y;
  if (p > 8) print("more than 8");
  else print("8 or less");
});
