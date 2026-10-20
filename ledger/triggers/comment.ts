// ledger: step 13, refused: a map of our own keeps no trigger() or hyperTriggers() records yet; this script has 1
// The action Comment: a trigger's name in StarEdit's list, which does nothing in the game.
trigger(P1, [always()], [comment("Starting minerals"), setResources(P1, "set", 50, "ore")]);
program(() => {
  print("started");
});
