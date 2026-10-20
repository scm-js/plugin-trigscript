// ledger: step 0, takes
// A wait of so many seconds of game time, 24 frames each: `await sleep(seconds(2))`.
program(async () => {
  await sleep(seconds(2));
  print("two seconds");
});
