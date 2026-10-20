// ledger: step 10, refused: a unit's verb (kill)
// A unit picked at random among those a filter matches: `randomUnit({ owner: P2 })`.
program(() => {
  randomUnit({ owner: P2 })?.kill();
});
