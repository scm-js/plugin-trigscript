// ledger: step 10, takes
// Whether a unit is a hallucination: `u.hallucinated`, here straight off a pick (`first(…)`).
program(() => {
  if (first({ owner: P1 })?.hallucinated) print("not real");
});
