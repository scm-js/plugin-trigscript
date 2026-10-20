// ledger: step 12, refused: the players' input (click)
// A click of the left mouse button, true on the frame it arrives: `clicked(P1)`.
program(async () => {
  while (true) {
    if (clicked(P1)) print("click");
    await nextFrame();
  }
});
