// ledger: step 13, takes
// The action Preserve Trigger in a trigger's actions: `preserveTrigger()`.
trigger(P1, [always()], [setResources(P1, "add", 1, "ore"), preserveTrigger()]);
program(() => {
  print("started");
});
