// ledger: step 4, takes
// The length of a line from its two sides: `Math.hypot(dx, dy)`.
program(() => {
  let dx = 0;
  let dy = 0;
  while (dx < 10) {
    dx += 3;
    dy += 4;
  }
  const d = Math.hypot(dx, dy);
  if (d > 19.5) print("more than 19.5");
  else print("19.5 or less");
});
