// ledger: step 0, takes
// A whole number made a fixed one, so that what is worked out with it keeps a fraction: `fixed(n)`.
program(() => {
  let n = 0;
  while (n < 5) n += 2;
  const x = fixed(n) + 0.5;
  if (x > 6) print("more than six");
  else print("six or less");
});
