// ledger: step 10, takes
// A unit sent somewhere by a Move order, that unit alone: `u.order("move", there)`.
program(() => {
  const u = first({ owner: P1 });
  if (u) u.order("move", locations.Anywhere);
});
