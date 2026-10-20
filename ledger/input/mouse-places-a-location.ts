// ledger: step 12, refused: the players' input (mouse)
// A location moved to where a player's mouse is: `centerLocation(spot, at.x, at.y)` after `const at = mouse(P1)`.
const spot = reserveLocation("where the mouse is");
program(async () => {
  while (true) {
    const at = mouse(P1);
    centerLocation(spot, at.x, at.y);
    await nextFrame();
  }
});
