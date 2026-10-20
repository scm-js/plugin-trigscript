// ledger: step 10, refused: a unit's kills written
// A unit's kill count, written: `u.kills = 5`.
program(() => {
  first({ owner: P1 })!.kills = 5;
});
