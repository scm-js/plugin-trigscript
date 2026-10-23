// ledger: step 13, takes
// A trigger that runs again every time its conditions hold: `{ preserve: true }`.
trigger(P1, [always()], [setResources(P1, "add", 1, "ore")], { preserve: true });
program(() => {
  print("started");
});
