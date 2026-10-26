// ledger: step 8, takes
// A text with the first of another in it replaced, or every one: `replace("a", "o")`, `replaceAll("a", "o")`.
program(() => {
  let n = 0;
  while (n < 12) n += 5;
  print((n > 10 ? "banana" : "papaya").replace("a", "o"));
  print((n > 10 ? "banana" : "papaya").replaceAll("a", "o"));
});
