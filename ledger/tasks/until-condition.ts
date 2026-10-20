// ledger: step 5, refused: the condition Elapsed Time
// A wait until a condition of the game holds, asked every frame: `await until(elapsedTime(">=", 5))`.
program(async () => {
  await until(elapsedTime(">=", 5));
  print("five seconds");
});
