// ledger: step 10, takes
// A unit picked at random among those a filter matches: `randomUnit({ owner: P2 })`.
program(() => {
  randomUnit({ owner: P2 })?.kill();
});
