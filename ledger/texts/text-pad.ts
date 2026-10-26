// ledger: step 8, takes
// A text made as wide as a number of characters, filled at the start or the end: `String(n).padStart(4, "0")`,
// `padEnd`.
program(() => {
  let n = 0;
  while (n < 12) n += 5;
  print(String(n).padStart(4, "0"));
  print("Wave".padEnd(n - 7, "."));
});
