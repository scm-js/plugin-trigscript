// ledger: step 5, refused: a read of the game (Accumulate)
// A condition that compares a quantity, read as a value: `accumulate(P1, "gas")`.
program(() => {
  const n = accumulate(P1, "gas");
  print(`${n}`);
});
