// ledger: step 13, takes
// An action kept in a trigger but switched off, as StarEdit can: `disabled(…)`.
trigger(P1, [always()], [displayText("Shown."), disabled(defeat())]);
program(() => {
  print("started");
});
