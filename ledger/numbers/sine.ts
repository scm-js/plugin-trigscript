// ledger: step 4, refused: Math.sin
// The sine of an angle in radians: `Math.sin(a)`.
program(() => {
  let a = 0;
  while (a < 1) a += 0.25;
  const s = Math.sin(a);
  if (s > 0.8) print("more than 0.8");
  else print("0.8 or less");
});
