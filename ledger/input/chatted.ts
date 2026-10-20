// ledger: step 12, refused: the players' input (chat)
// A line a player typed, matched whole: `if (chatted(P1, "-help"))`.
program(async () => {
  while (true) {
    if (chatted(P1, "-help")) print("help");
    await nextFrame();
  }
});
