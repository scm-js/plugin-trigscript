// ledger: step 4, takes
// The cosine of an angle in radians: `Math.cos(a)`.
program(() => {
  let a = 0;
  while (a < 1) a += 0.25;
  const c = Math.cos(a);
  if (c > 0.5) print("more than 0.5");
  else print("0.5 or less");
});
