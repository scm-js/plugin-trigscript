// ledger: step 7, refused: a map of our own has one program; this script has 2
// Two programs in one script, each running beside the other.
program(() => {
  print("first");
});
program(() => {
  print("second");
});
