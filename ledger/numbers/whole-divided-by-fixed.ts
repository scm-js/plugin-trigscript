// ledger: step 4, refused: a quotient of fixed numbers
// A whole number divided by one made fixed, which keeps the fraction: `n / fixed(d)` (3 / fixed(2) is 1.5).
program(() => {
  let n = 0;
  let d = 1;
  while (n < 5) {
    n += 3;
    d += 1;
  }
  const q = n / fixed(d);
  if (q > 2) print("more than 2");
  else print("2 or less");
});
