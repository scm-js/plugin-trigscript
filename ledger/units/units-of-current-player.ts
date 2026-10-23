// ledger: step 10, takes
// A loop over the units of the player the program runs as: `unitsOf(CurrentPlayer)`.
program(() => {
  let n = 0;
  for (const u of unitsOf(CurrentPlayer)) n += 1;
  print(`${n}`);
}, { owner: P2 });
