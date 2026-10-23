// ledger: step 13, takes
// The action Comment: a trigger's name in StarEdit's list, which does nothing in the game.
trigger(P1, [always()], [comment("Starting minerals"), setResources(P1, "set", 50, "ore")]);
program(() => {
  print("started");
});
