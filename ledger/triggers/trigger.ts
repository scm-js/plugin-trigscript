// ledger: step 13, refused: a map of our own keeps no trigger() or hyperTriggers() records yet; this script has 1
// A trigger of the map's own, beside a program: `trigger(players, conditions, actions)`.
trigger(P1, [bring(P1, units.TerranMarine, locations.Anywhere, ">=", 1)], [displayText("A Marine is here."), victory()]);
program(() => {
  print("started");
});
