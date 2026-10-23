// ledger: step 10, takes
// A unit killed: `u.kill()`.
program(() => {
  first({ owner: P1 })?.kill();
});
