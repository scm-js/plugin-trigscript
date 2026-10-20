// ledger: step 12, refused: the players' input (mouse)
// Where a player's mouse is on the map, the same on every computer: `mouse(P1).x`, `mouse(P1).y`.
program(async () => {
  while (true) {
    const at = mouse(P1);
    print(`${at.x}, ${at.y}`);
    await nextFrame();
  }
});
