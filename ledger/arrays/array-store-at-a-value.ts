// ledger: step 3, takes
// A value stored into a cell of an array of the program at a place that changes while the game runs: `hp[i] = v`.
program(() => {
  const hp = [0, 0, 0, 0];
  let i = 0;
  while (i < 4) {
    hp[i] = i * 10 + 5;
    i += 1;
  }
  print(`${hp[2]}`);
});
