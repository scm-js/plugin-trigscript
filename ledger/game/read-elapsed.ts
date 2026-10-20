// ledger: step 5, refused: a read of the game (Elapsed Time)
// Game seconds since the start, read when the line runs: `elapsed()`.
program(() => {
  const n = elapsed();
  print(`${n}`);
});
