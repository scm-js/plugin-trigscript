// ledger: step 13, takes
// A trigger of the map's own, beside a program: `trigger(players, conditions, actions)`.
trigger(P1, [bring(P1, units.TerranMarine, locations.Anywhere, ">=", 1)], [displayText("A Marine is here."), victory()]);
program(() => {
  print("started");
});
