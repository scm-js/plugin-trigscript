// ledger: step 4, refused: Math.atan2
// The angle from the x axis to a point, in radians: `Math.atan2(y, x)`.
program(() => {
  let x = 0;
  let y = 0;
  while (x < 10) {
    x += 3;
    y += 2;
  }
  const a = Math.atan2(y, x);
  if (a > 0.5) print("more than 0.5");
  else print("0.5 or less");
});
