// ledger: step 11, takes
// A task that runs on after the program has ended.
program(async () => {
  start(async () => {
    await sleep(frames(5));
    print("later");
  });
  print("end");
});
