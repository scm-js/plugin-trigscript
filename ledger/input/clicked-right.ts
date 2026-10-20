// ledger: step 12, refused: the players' input (click)
// A click of the right mouse button: `clicked(P1, "right")`.
program(async () => {
  while (true) {
    if (clicked(P1, "right")) print("right");
    await nextFrame();
  }
});
