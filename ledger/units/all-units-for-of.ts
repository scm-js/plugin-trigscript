// ledger: step 10, refused: a loop over units
// A loop over every unit on the map: `for (const u of allUnits())`.
program(() => {
  let n = 0;
  for (const u of allUnits()) n += 1;
  print(`${n}`);
});
