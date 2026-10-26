// ledger: step 4, takes
// The tangent of an angle in radians, its sine over its cosine: `Math.tan(a)`.
program(() => {
  let a = 0;
  while (a < 1) a += 0.25;
  const t = Math.tan(a);
  if (t > 1.5) print("more than 1.5");
  else print("1.5 or less");
});
