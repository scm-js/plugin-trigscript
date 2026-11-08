// ledger: step 10, takes
// Where a unit's order is aimed, in pixels: `u.orderTargetX`, `u.orderTargetY`.
program(() => {
  const u = first({ owner: P1 });
  if (u) print(`going to ${u.orderTargetX},${u.orderTargetY}`);
});
