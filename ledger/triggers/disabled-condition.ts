// ledger: step 13, refused: a map of our own keeps no trigger() or hyperTriggers() records yet; this script has 1
// A condition kept in a trigger but switched off, as StarEdit can: `disabled(…)`.
trigger(P1, [always(), disabled(never())], [displayText("Fires anyway.")]);
program(() => {
  print("started");
});
