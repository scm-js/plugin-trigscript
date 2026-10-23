// ledger: step 12, takes
// A key a player pressed, true on the frame the press arrives: `keyPressed(P1, "F7")`, looked for every frame.
program(async () => {
  while (true) {
    if (keyPressed(P1, "F7")) print("help");
    await nextFrame();
  }
});
