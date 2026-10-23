// ledger: step 10, takes
// A unit sent to attack-move, that unit alone: `u.order("attack", there)`.
program(() => {
  const u = first({ owner: P1 });
  if (u) u.order("attack", locations.Anywhere);
});
