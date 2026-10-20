// ledger: step 3, takes
// An array of a length written in the script, every cell one value: `new Array(8).fill(3)`.
program(() => {
  const board = new Array(8).fill(3);
  let i = 0;
  while (i < 5) i += 2;
  board[i] = 7;
  print(`${board[i] + board[0]}`);
});
