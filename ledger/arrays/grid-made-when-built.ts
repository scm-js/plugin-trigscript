// ledger: step 3, takes
// A grid made the ways people make one, worked out when the map is built:
// `Array.from({ length: 3 }, () => new Array(4).fill(0))`.
program(() => {
  const grid = Array.from({ length: 3 }, () => new Array(4).fill(0));
  let y = 0;
  while (y < 2) y += 1;
  grid[y][3] = 5;
  print(`${grid[2][3]}`);
});
