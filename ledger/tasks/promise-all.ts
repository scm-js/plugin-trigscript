// ledger: step 11, refused: Promise.all
// Two waits side by side, the program going on when both have ended: `await Promise.all([…])`.
program(async () => {
  await Promise.all([
    (async () => {
      await sleep(frames(3));
      print("a");
    })(),
    sleep(frames(5)),
  ]);
  print("both");
});
