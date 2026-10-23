// ledger: step 10, takes
// A unit taken off the map without a death: `u.remove()`.
program(() => {
  first({ owner: P1 })?.remove();
});
