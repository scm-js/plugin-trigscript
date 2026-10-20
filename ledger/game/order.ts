// ledger: step 5, refused: the action Order
// The action Order: units at a location sent to another, to move, patrol or attack. (Built outside the
// program and stood as a statement inside it: written inside, `order(…)` does not compile.)
const charge = order(P1, units.TerranMarine, locations.Anywhere, locations.Anywhere, "attack");
program(() => {
  charge;
});
