// ledger: step 13, takes
// A condition turned around by `not(…)` in a trigger's conditions: a comparison flips, a switch test flips,
// always becomes never.
trigger(P1, [not(bring(P1, units.AnyUnit, locations.Anywhere, ">=", 1)), not(switchIs(switches.Switch1, "set"))], [defeat()]);
program(() => {
  print("started");
});
