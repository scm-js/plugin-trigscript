// ledger: step 8, refused: two texts compared
// Whether a text is empty, by testing it: `if (s)`.
program(() => {
  let n = 0;
  while (n < 12) n += 5;
  if (n > 10 ? "" : "x") print("not empty");
  else print("empty");
});
