// ledger: step 5, refused: the condition Never
// The condition Never as a test in an `if`.
program(() => {
  if (never()) print("yes");
});
