// ledger: step 4, takes
// A number with a fraction divided by a number written in the script: `x / 3`.
program(() => {
  let x = 0.5;
  while (x < 3) x += 0.75;
  const q = x / 3;
  if (q > 1) print("more than 1");
  else print("1 or less");
});
