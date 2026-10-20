// ledger: step 5, takes
// The action Order: units at a location sent to another, to move, patrol or attack — "attack" or orders.AttackMove,
// one of the three orders the action gives (any other of orders.* is a compile error).
program(() => {
  order(P1, units.TerranMarine, locations.Anywhere, locations.Anywhere, "attack");
  order(P1, units.TerranMarine, locations.Anywhere, locations.Anywhere, orders.Move);
});
