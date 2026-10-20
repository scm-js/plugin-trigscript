// ledger: step 4, refused: Math.atan2
// The angle whose tangent is a value, in radians: `Math.atan(t)`.
program(() => {
  let t = 0;
  while (t < 1) t += 0.25;
  const a = Math.atan(t);
  if (a > 0.7) print("more than 0.7");
  else print("0.7 or less");
});
