// ledger: step 5, refused: a read of the game (Countdown Timer)
// The countdown timer in game seconds, read when the line runs: `countdown()`.
program(() => {
  const n = countdown();
  print(`${n}`);
});
