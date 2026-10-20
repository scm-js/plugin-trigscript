// ledger: step 10, refused: a unit's verb (give)
// A unit handed to another player: `u.give(P2)`.
program(() => {
  first({ owner: P1 })?.give(P2);
});
