// ledger: step 10, takes
// A loop over units that passes some by: `continue` for a burrowed unit.
program(() => {
  let n = 0;
  for (const u of allUnits()) {
    if (u.burrowed) continue;
    n += 1;
  }
  print(`${n}`);
});
