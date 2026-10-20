// ledger: step 13, refused: a map of our own keeps no trigger() or hyperTriggers() records yet; this script has 1
// A trigger for several players at once: `trigger([P1, P2], …)`.
trigger([P1, P2], [elapsedTime(">=", 10)], [displayText("Ten seconds in.")]);
program(() => {
  print("started");
});
