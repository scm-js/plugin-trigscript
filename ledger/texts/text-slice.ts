// ledger: step 8, refused: a part of a text (slice)
// Part of a text, between places that change while the game runs: `"Terran Marine".slice(i, i + 4)`, and
// `substring`.
program(() => {
  let i = 0;
  while (i < 6) i += 3;
  print("Terran Marine".slice(i, i + 4));
  print("Terran Marine".substring(i + 1));
});
