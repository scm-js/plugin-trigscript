// ledger: step 0, takes
// A `let` variable: a number the program keeps, set and changed while the game runs.
program(() => {
  let gold = 50;
  while (gold < 100) gold += 25;
  print(`${gold}`);
});
