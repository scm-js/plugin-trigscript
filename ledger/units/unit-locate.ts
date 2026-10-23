// ledger: step 10, takes
// A location centred on a unit, so that an action can happen where the unit is: `u.locate(there)`.
const there = reserveLocation("where the unit is");
program(() => {
  first({ owner: P1 })?.locate(there);
});
