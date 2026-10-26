// ledger: step 10, takes
// A unit handed to another player: `u.give(P2)`.
program(() => {
  first({ owner: P1 })?.give(P2);
});
