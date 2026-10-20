// ledger: step 5, refused: a read of the game (Accumulate)
// A player's minerals and gas added up, read when the line runs: `resources(P1, "oreAndGas")`.
program(() => {
  const n = resources(P1, "oreAndGas");
  print(`${n}`);
});
