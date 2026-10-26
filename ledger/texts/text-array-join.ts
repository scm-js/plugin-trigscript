// ledger: step 8, takes
// The texts of an array of texts as one, with a separator between them: `names.join(", ")`.
program(() => {
  const names = ["Raynor", "Kerrigan"];
  let n = 0;
  while (n < 12) n += 5;
  if (n > 10) names[1] = "Tassadar";
  print(names.join(", "));
});
