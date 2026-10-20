// ledger: step 8, refused: a text's toUpperCase()
// A text in capitals or in small letters, A to Z only: `toUpperCase()`, `toLowerCase()`.
program(() => {
  let n = 0;
  while (n < 12) n += 5;
  print((n > 10 ? "Medic" : "Marine").toUpperCase());
  print((n > 10 ? "Medic" : "Marine").toLowerCase());
});
