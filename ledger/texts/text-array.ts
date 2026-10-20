// ledger: step 8, refused: a text of the program's
// An array of texts of the program, stored and read at a place that changes while the game runs: `names[i] = "Medic"`.
program(() => {
  const names = ["Marine", "Marine", "Marine"];
  let i = 0;
  while (i < 2) i += 1;
  names[i] = "Medic";
  print(names[i]);
});
