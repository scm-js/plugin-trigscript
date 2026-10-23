// ledger: step 11, takes
// A task written where it is started: `start(async () => { … })`.
program(async () => {
  start(async () => {
    await sleep(frames(5));
    print("later");
  });
  print("now");
});
