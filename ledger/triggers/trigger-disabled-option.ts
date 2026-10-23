// ledger: step 13, takes
// A trigger kept in the map but switched off: `{ disabled: true }`.
trigger(P1, [always()], [victory()], { disabled: true });
program(() => {
  print("started");
});
