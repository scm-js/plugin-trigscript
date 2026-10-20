// ledger: step 13, refused: a map of our own keeps no trigger() or hyperTriggers() records yet; this script has 1
// A condition turned around by `not(…)` in a trigger's conditions: a comparison flips, a switch test flips,
// always becomes never.
trigger(P1, [not(bring(P1, units.AnyUnit, locations.Anywhere, ">=", 1)), not(switchIs(switches.Switch1, "set"))], [defeat()]);
program(() => {
  print("started");
});
