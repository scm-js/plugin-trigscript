// ledger: step 13, takes
// The action Preserve Trigger in a trigger's actions, by its short name: `preserve()`.
trigger(P1, [always()], [setResources(P1, "add", 1, "ore"), preserve()]);
program(() => {
  print("started");
});
