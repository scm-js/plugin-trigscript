// ledger: step 8, takes
// A text kept in a variable and changed while the game runs: `let unit = "Marine"`, then `unit = "Medic"`.
program(() => {
  let unit = "Marine";
  let n = 0;
  while (n < 12) n += 5;
  if (n > 10) unit = "Medic";
  print(unit);
});
