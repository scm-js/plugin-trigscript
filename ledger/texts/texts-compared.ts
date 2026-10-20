// ledger: step 8, takes
// Two texts compared while the game runs: `===`, `!==`, and `<` in the order of their characters.
program(() => {
  let n = 0;
  while (n < 12) n += 5;
  if ((n > 10 ? "Medic" : "Marine") < "Mf") print("before");
  else print("after");
});
