// ledger: step 5, takes
// The condition Accumulate as a test in an `if`: a player has at least so many minerals.
program(() => {
  if (accumulate(P1, ">=", 500, "ore")) print("yes");
});
