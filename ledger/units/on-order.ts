// ledger: step 11, takes
// Every unit that takes up a new order, with the order and the one it had: `on.order((u, order, was) => …)`.
program(async () => {
  on.order((u, order, was) => {
    if (order == orders.Move) print("moving");
  });
});
