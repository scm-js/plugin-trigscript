// ledger: step 13, takes
// A condition kept in a trigger but switched off, as StarEdit can: `disabled(…)`.
trigger(P1, [always(), disabled(never())], [displayText("Fires anyway.")]);
program(() => {
  print("started");
});
