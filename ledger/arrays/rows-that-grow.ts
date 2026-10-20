// ledger: step 9, refused: an array that grows
// An array of arrays each of its own length, a row pushed to: `rows[i].push(v)`.
program(() => {
  const rows: number[][] = [[], [], []];
  let i = 0;
  while (i < 2) {
    rows[i].push(i + 5);
    i += 1;
  }
  rows[1].push(9);
  print(`${rows[1].length} ${rows[1][1]}`);
});
