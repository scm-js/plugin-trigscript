// ledger: step 5, refused: the condition Elapsed Time
// The condition Elapsed Time as a test in an `if`: so many game seconds have gone by.
program(() => {
  if (elapsedTime(">=", 60)) print("yes");
});
