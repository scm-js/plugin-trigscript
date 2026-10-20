// ledger: step 8, refused: a ?: of texts
// One text or another, by a test while the game runs: `print(n > 10 ? "Medic" : "Marine")`.
program(() => {
  let n = 0;
  while (n < 12) n += 5;
  print(n > 10 ? "Medic" : "Marine");
});
