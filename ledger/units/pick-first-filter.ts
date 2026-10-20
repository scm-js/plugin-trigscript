// ledger: step 10, refused: a unit's verb (kill)
// The first unit a filter matches: `first({ owner: P2, type: units.ZergZergling })`.
program(() => {
  first({ owner: P2, type: units.ZergZergling })?.kill();
});
