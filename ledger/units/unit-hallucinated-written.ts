// ledger: step 10, takes
// A unit made a hallucination by a write: `u.hallucinated = true` (double damage, gone after a while).
program(() => {
  first({ owner: P2 })!.hallucinated = true;
});
