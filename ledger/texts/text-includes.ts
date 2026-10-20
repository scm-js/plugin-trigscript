// ledger: step 8, refused: a text's includes
// Whether a text of the program has another in it: `s.includes("ed")`.
program(() => {
  let n = 0;
  while (n < 12) n += 5;
  if ((n > 10 ? "Medic" : "Marine").includes("ed")) print("has it");
  else print("has it not");
});
