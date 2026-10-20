// ledger: step 4, refused: Math.sqrt
// The square root of a whole number, as a number with a fraction: `Math.sqrt(n)`.
program(() => {
  let n = 0;
  while (n < 20) n += 7;
  const r = Math.sqrt(n);
  if (r > 4.5) print("more than 4.5");
  else print("4.5 or less");
});
