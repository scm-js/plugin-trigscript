// ledger: step 10, refused: a unit's orderId
// What a unit is doing, compared with an order: `u.orderId == orders.Move`, here straight off a pick (`first(…)`).
program(() => {
  if (first({ owner: P1 })?.orderId == orders.Move) print("moving");
});
