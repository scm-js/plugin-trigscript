// ledger: step 10, refused: a unit's verb (remove)
// A unit taken off the map without a death: `u.remove()`.
program(() => {
  first({ owner: P1 })?.remove();
});
