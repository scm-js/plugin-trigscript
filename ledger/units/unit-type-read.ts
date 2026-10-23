// ledger: step 10, takes
// What a unit is, compared with a type: `u.type == units.TerranMarine`, here straight off a pick (`first(…)`).
program(() => {
  if (first({ owner: P1 })?.type == units.TerranMarine) print("a marine");
});
