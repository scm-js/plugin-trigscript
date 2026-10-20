// ledger: step 10, refused: a unit's verb (kill)
// A unit killed: `u.kill()`.
program(() => {
  first({ owner: P1 })?.kill();
});
