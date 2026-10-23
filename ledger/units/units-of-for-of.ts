// ledger: step 10, takes
// A loop over a player's units: `for (const u of unitsOf(P1))`.
program(() => {
  let n = 0;
  for (const u of unitsOf(P1)) n += 1;
  print(`${n}`);
});
