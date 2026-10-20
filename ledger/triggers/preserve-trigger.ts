// ledger: step 13, refused: a map of our own keeps no trigger() or hyperTriggers() records yet; this script has 1
// The action Preserve Trigger in a trigger's actions: `preserveTrigger()`.
trigger(P1, [always()], [setResources(P1, "add", 1, "ore"), preserveTrigger()]);
program(() => {
  print("started");
});
