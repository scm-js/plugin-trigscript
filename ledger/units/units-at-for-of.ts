// ledger: step 10, refused: a loop over units
// A loop over the units at a location: `for (const u of unitsAt(…))`.
program(() => {
  let n = 0;
  for (const u of unitsAt(locations.Anywhere)) if (u.hp > 0) n += 1;
  print(`${n}`);
});
