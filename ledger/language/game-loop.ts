// ledger: step 0, takes
// A loop that goes on for ever, `while (true)`, giving the frame back with `sleep(frames(1))` at every turn.
program(() => {
  let n = 0;
  while (true) {
    n += 1;
    if (n == 48) print("two seconds");
    sleep(frames(1));
  }
});
