// ledger: step 5, takes
// A player's minerals and gas added up, read when the line runs: `resources(P1, "oreAndGas")`.
program(() => {
  const n = resources(P1, "oreAndGas");
  print(`${n}`);
});
