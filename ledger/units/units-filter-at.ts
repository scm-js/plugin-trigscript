// ledger: step 10, takes
// A loop over the units inside a location by the filter's `at`: `allUnits({ at: there })`.
const there = reserveLocation("where to count");
program(() => {
  let n = 0;
  for (const u of allUnits({ at: there })) n += 1;
  print(`${n}`);
});
