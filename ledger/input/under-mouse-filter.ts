// ledger: step 12, refused: a unit
// The nearest unit to a player's mouse that a filter matches, within so many pixels: `underMouse(P1, { owner: P2, within: 32 })`.
program(async () => {
  while (true) {
    if (underMouse(P1, { owner: P2, within: 32 })) print("over an enemy");
    await nextFrame();
  }
});
