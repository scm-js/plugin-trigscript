// ledger: step 10, refused: a loop over units
// A loop over one player's units by the filter's owner: `allUnits({ owner: P2 })`.
program(() => {
  let n = 0;
  for (const u of allUnits({ owner: P2 })) n += 1;
  print(`${n}`);
});
