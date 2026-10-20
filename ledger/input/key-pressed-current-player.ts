// ledger: step 12, refused: the players' input (key)
// A key pressed by the player the program runs as: `keyPressed(CurrentPlayer, "Space")`.
program(async () => {
  while (true) {
    if (keyPressed(CurrentPlayer, "Space")) print("jump");
    await nextFrame();
  }
}, { owner: P2 });
