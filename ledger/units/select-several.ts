// ledger: step 10, takes
// What a player has selected made several units at once: `select(P1, [a, b])`.
program(() => {
  select(P1, [first({ owner: P1, type: units.TerranMarine })!, first({ owner: P1, type: units.TerranSCV })!]);
});
