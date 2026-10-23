// ledger: step 10, takes
// A loop over a player's factories: `unitsOf(P1, { type: units.Factories })`.
program(() => {
  let n = 0;
  for (const u of unitsOf(P1, { type: units.Factories })) n += 1;
  print(`${n}`);
});
