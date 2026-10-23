// ledger: step 13, takes
// A trigger for several players at once: `trigger([P1, P2], …)`.
trigger([P1, P2], [elapsedTime(">=", 10)], [displayText("Ten seconds in.")]);
program(() => {
  print("started");
});
