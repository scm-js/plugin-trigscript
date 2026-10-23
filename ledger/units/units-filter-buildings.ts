// ledger: step 10, takes
// A loop over a player's buildings: `unitsOf(P1, { type: units.Buildings })`.
program(() => {
  let n = 0;
  for (const u of unitsOf(P1, { type: units.Buildings })) n += 1;
  print(`${n}`);
});
