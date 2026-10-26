// ledger: step 12, takes
// A line a player typed, matched whole: `if (chatted(P1, "-help"))`.
program(async () => {
  while (true) {
    if (chatted(P1, "-help")) print("help");
    await nextFrame();
  }
});
