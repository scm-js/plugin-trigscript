// ledger: step 12, refused: a unit
// The unit nearest a player's mouse, or none: `underMouse(P1)`.
program(async () => {
  while (true) {
    if (underMouse(P1)) print("over a unit");
    await nextFrame();
  }
});
