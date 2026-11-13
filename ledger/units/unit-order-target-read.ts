// ledger: step 10, takes
// The unit a unit's order is aimed at, or none: `u.orderTarget`.
program(() => {
  const u = first({ owner: P1 });
  if (u) {
    const aimed = u.orderTarget;
    if (aimed) print(`aimed at a unit of type ${aimed.type}`);
  }
});
