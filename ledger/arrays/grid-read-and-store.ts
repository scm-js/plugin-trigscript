// ledger: step 3, takes
// A grid, an array of rows, read and stored at two places that change while the game runs: `grid[y][x]`.
program(() => {
  const grid = [
    [0, 0, 0],
    [0, 0, 0],
  ];
  let x = 0;
  let y = 0;
  while (x < 2) {
    x += 1;
    y = 1;
  }
  grid[y][x] = 7;
  print(`${grid[1][2]}`);
});
