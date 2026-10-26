// ledger: step 10, takes
// A pick compared with null: `first(…) == null` when it found none.
program(() => {
  if (first({ owner: P2 }) == null) print("none");
});
