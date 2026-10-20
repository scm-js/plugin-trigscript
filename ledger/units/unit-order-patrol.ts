// ledger: step 10, refused: a unit kept in a variable
// A unit sent to patrol, that unit alone: `u.order("patrol", there)`.
program(() => {
  const u = first({ owner: P1 });
  if (u) u.order("patrol", locations.Anywhere);
});
