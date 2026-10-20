// ledger: step 4, refused: Math.sqrt
// The square root of a number with a fraction: `Math.sqrt(x)`.
program(() => {
  let x = 0.5;
  while (x < 3) x += 0.75;
  const r = Math.sqrt(x);
  if (r > 1.5) print("more than 1.5");
  else print("1.5 or less");
});
