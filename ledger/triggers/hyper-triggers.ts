// ledger: step 13, refused: a map of our own keeps no trigger() or hyperTriggers() records yet; this script has 3
// `hyperTriggers()`: preserved triggers of Wait(0)s that make the game go through the trigger list every
// 2 frames instead of every 31.
hyperTriggers(P8);
program(() => {
  print("started");
});
