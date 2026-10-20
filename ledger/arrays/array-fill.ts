// ledger: step 3, takes
// Every cell of an array of the program set to a value that changes while the game runs: `board.fill(v)`.
program(() => {
  const board = [1, 2, 3, 4];
  let v = 0;
  while (v < 5) v += 2;
  board.fill(v);
  print(`${board[3]}`);
});
