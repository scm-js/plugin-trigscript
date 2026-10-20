// ledger: step 3, takes
// A row of a grid kept in a variable and looped over: `const row = grid[y]`, which is the grid's own cells.
program(() => {
  const grid = [
    [1, 2, 3],
    [4, 5, 6],
  ];
  grid[0][0] = 9;
  let y = 0;
  while (y < 1) y += 1;
  const row = grid[y];
  let total = 0;
  for (const c of row) total += c;
  print(`${total}`);
});
