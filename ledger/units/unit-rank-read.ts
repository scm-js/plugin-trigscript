// ledger: step 10, takes
// A unit's rank, the number added to its type's: `u.rank`.
program(() => {
  const u = first({ owner: P1 });
  if (u) print(`rank ${u.rank}`);
});
