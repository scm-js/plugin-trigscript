// ledger: step 10, takes
// A loop over the units of one type: `allUnits({ type: units.TerranMarine })`.
program(() => {
  let n = 0;
  for (const u of allUnits({ type: units.TerranMarine })) n += 1;
  print(`${n}`);
});
