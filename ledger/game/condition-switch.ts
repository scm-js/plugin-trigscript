// ledger: step 5, takes
// The condition Switch as a test in an `if`: one of the map's switches (`switches.*`) is set.
program(() => {
  if (switchIs(switches.Switch1, "set")) print("yes");
});
