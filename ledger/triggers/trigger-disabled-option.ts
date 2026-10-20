// ledger: step 13, refused: a map of our own keeps no trigger() or hyperTriggers() records yet; this script has 1
// A trigger kept in the map but switched off: `{ disabled: true }`.
trigger(P1, [always()], [victory()], { disabled: true });
program(() => {
  print("started");
});
