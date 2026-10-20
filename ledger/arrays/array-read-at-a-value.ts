// ledger: step 3, takes
// A cell of an array of the program read at a value that changes while the game runs: `hp[i]`.
program(() => {
  const hp = [10, 20, 30, 40];
  hp[0] = 15;
  let i = 0;
  while (i < 2) i += 1;
  print(`${hp[i]}`);
});
