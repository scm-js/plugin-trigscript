// ledger: step 13, refused: a map of our own keeps no trigger() or hyperTriggers() records yet; this script has 1
// A trigger that runs again every time its conditions hold: `{ preserve: true }`.
trigger(P1, [always()], [setResources(P1, "add", 1, "ore")], { preserve: true });
program(() => {
  print("started");
});
