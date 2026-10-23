// ledger: step 11, takes
// The units of a type that take up one order: `on.order(units.TerranMarine, orders.Move, (u) => …)`.
program(async () => {
  on.order(units.TerranMarine, orders.Move, (u) => {
    u.stim = 50;
  });
});
