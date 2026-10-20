// ledger: step 5, takes
// A condition as the test of a `while`: the loop goes on, a frame at a time, until the switch is set.
program(() => {
  while (!switchIs(switches.Switch1, "set")) sleep(frames(1));
  print("open");
});
