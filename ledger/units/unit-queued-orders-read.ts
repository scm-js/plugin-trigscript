// ledger: step 10, takes
// How many orders wait behind the one a unit is doing: `u.queuedOrders`.
program(() => {
  if (first({ owner: P1 })!.queuedOrders > 0) print("more to do");
});
