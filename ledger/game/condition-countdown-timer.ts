// ledger: step 5, refused: the condition Countdown Timer
// The condition Countdown Timer as a test in an `if`: the timer is at most so many seconds.
program(() => {
  if (countdownTimer("<=", 10)) print("yes");
});
