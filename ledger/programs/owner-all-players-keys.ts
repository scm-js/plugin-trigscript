// ledger: step 12, refused: a map of our own has no per-player program yet
// Each player's own keys in a program for every player: `keyPressed(CurrentPlayer, "Space")` with `{ owner: AllPlayers }`.
program(async () => {
  while (true) {
    if (keyPressed(CurrentPlayer, "Space")) print("jump");
    await nextFrame();
  }
}, { owner: AllPlayers });
