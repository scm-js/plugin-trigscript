// ledger: step 10, takes
// A loop over the neutral player's units, the critters and the mineral fields: `unitsOf(P12)`.
program(() => {
  let n = 0;
  for (const u of unitsOf(P12)) n += 1;
  print(`${n}`);
});
