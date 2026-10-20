// ledger: step 0, takes
// A wait of so many frames on its own, in a program that is not async: `sleep(frames(3))`.
program(() => {
  print("now");
  sleep(frames(3));
  print("later");
});
