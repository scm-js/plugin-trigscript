// ledger: step 12, takes
// A click of the middle mouse button: `clicked(P1, "middle")`.
program(async () => {
  while (true) {
    if (clicked(P1, "middle")) print("middle");
    await nextFrame();
  }
});
